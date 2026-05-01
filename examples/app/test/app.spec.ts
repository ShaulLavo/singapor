import { expect, test } from "@playwright/test";

test("mounts the editor pane in the real app shell", async ({ page }) => {
  await page.goto("/");

  const editorPane = page.locator("#editor-container");
  await expect(editorPane).toBeVisible();
  await expect(editorPane).toHaveCSS("display", "flex");
});

test("loads Shiki token highlights for a source file", async ({ page }) => {
  const file = {
    path: "src/index.ts",
    text: "const answer: number = 42;\n",
  };
  await mockGitHubSource(page, file.path, file.text);
  await page.addInitScript((path) => {
    localStorage.clear();
    localStorage.setItem("editor-selected-file", path);
  }, file.path);

  await page.goto("/");

  await expect(page.locator(".editor-virtualized")).toContainText("const answer");
  await expect.poll(() => tokenHighlightRangeCount(page)).toBeGreaterThan(0);
});

test("shows TypeScript LSP diagnostics for a source file", async ({ page }) => {
  const file = {
    path: "src/index.ts",
    text: "const value: string = 1;\n",
  };
  await mockTypeScriptLibs(page);
  await mockGitHubSource(page, file.path, file.text);
  await page.addInitScript((path) => {
    localStorage.clear();
    localStorage.setItem("editor-selected-file", path);
  }, file.path);

  await page.goto("/");

  await expect(page.locator(".editor-virtualized")).toContainText("const value");
  await expect
    .poll(() => diagnosticHighlightRangeCount(page), { timeout: 15000 })
    .toBeGreaterThan(0);
  await expect(page.locator("#status-typescript")).toContainText(/TS .*error/);

  const hoverRect = await textRectFor(page, "value", 0);
  await page.mouse.move(hoverRect.x + 2, hoverRect.y + hoverRect.height / 2);
  await expect(page.locator(".editor-typescript-lsp-hover")).toContainText("value", {
    timeout: 15000,
  });
  const tooltipRect = await page.locator(".editor-typescript-lsp-hover").boundingBox();
  expect(tooltipRect?.y ?? 0).toBeGreaterThan(hoverRect.y);
});

test("shows TypeScript hover hints and jumps to definitions", async ({ page }) => {
  const files = [
    {
      path: "src/index.ts",
      text: [
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        'import { answer } from "./other";',
        "const value: string = answer;",
        "",
      ].join("\n"),
    },
    {
      path: "src/other.ts",
      text: "export const answer = 42;\n",
    },
  ];
  await mockTypeScriptLibs(page);
  await mockGitHubSourceFiles(page, files);
  await page.addInitScript((path) => {
    localStorage.clear();
    localStorage.setItem("editor-selected-file", path);
  }, "src/index.ts");

  await page.goto("/");
  await expect(page.locator(".editor-virtualized")).toContainText("const value");
  await expect
    .poll(() => diagnosticHighlightRangeCount(page), { timeout: 15000 })
    .toBeGreaterThan(0);

  const hoverRect = await textRectFor(page, "value", 0);
  await page.mouse.move(hoverRect.x + 2, hoverRect.y + hoverRect.height / 2);
  await expect(page.locator(".editor-typescript-lsp-hover")).toContainText("value", {
    timeout: 15000,
  });
  await expect(page.locator(".editor-typescript-lsp-hover")).toContainText(
    /Type 'number' is not assignable to type 'string'|number/,
  );

  const definitionRect = await textRectFor(page, "answer", 0);
  await page.mouse.move(definitionRect.x + 2, definitionRect.y + definitionRect.height / 2);
  await expect(page.locator(".editor-typescript-lsp-hover")).toContainText("answer", {
    timeout: 15000,
  });
  const tooltipRect = await page.locator(".editor-typescript-lsp-hover").boundingBox();
  expect(tooltipRect?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(definitionRect.y);

  await page.keyboard.down("Control");
  await page.mouse.move(definitionRect.x + 2, definitionRect.y + definitionRect.height / 2);
  await expect
    .poll(() => definitionLinkHighlightRangeCount(page), { timeout: 15000 })
    .toBeGreaterThan(0);
  await page.mouse.click(definitionRect.x + 2, definitionRect.y + definitionRect.height / 2);
  await page.keyboard.up("Control");

  await expect(page.locator(".editor-virtualized")).toContainText("export const answer", {
    timeout: 15000,
  });
  await expect(page.locator(".entry.active")).toContainText("other.ts");
});

async function tokenHighlightRangeCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const registry = (
      globalThis.CSS as { highlights?: Iterable<[string, { readonly size: number }]> } | undefined
    )?.highlights;
    if (!registry) return 0;

    let count = 0;
    for (const [name, highlight] of registry) {
      if (!name.includes("-token-")) continue;
      count += highlight.size;
    }

    return count;
  });
}

async function diagnosticHighlightRangeCount(
  page: import("@playwright/test").Page,
): Promise<number> {
  return page.evaluate(() => {
    const registry = (
      globalThis.CSS as { highlights?: Iterable<[string, { readonly size: number }]> } | undefined
    )?.highlights;
    if (!registry) return 0;

    let count = 0;
    for (const [name, highlight] of registry) {
      if (!name.includes("typescript-lsp-error")) continue;
      count += highlight.size;
    }

    return count;
  });
}

async function definitionLinkHighlightRangeCount(
  page: import("@playwright/test").Page,
): Promise<number> {
  return page.evaluate(() => {
    const registry = (
      globalThis.CSS as { highlights?: Iterable<[string, { readonly size: number }]> } | undefined
    )?.highlights;
    if (!registry) return 0;

    let count = 0;
    for (const [name, highlight] of registry) {
      if (!name.includes("typescript-lsp-definition-link")) continue;
      count += highlight.size;
    }

    return count;
  });
}

async function textRectFor(
  page: import("@playwright/test").Page,
  query: string,
  occurrence: number,
): Promise<{
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}> {
  const rect = await page.evaluate(
    ({ query, occurrence }) => {
      const walker = document.createTreeWalker(
        document.querySelector(".editor-virtualized")!,
        NodeFilter.SHOW_TEXT,
      );
      let seen = 0;

      for (;;) {
        const node = walker.nextNode();
        if (!node) break;

        const text = node.textContent ?? "";
        const index = text.indexOf(query);
        if (index === -1) continue;
        if (seen !== occurrence) {
          seen += 1;
          continue;
        }

        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + query.length);
        const item = range.getBoundingClientRect();
        return {
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
        };
      }

      return null;
    },
    { query, occurrence },
  );
  if (!rect) throw new Error(`Unable to find text rect for ${query}`);
  return rect;
}

async function mockTypeScriptLibs(page: import("@playwright/test").Page): Promise<void> {
  await page.route("https://playgroundcdn.typescriptlang.org/cdn/**/typescript/lib/**", (route) =>
    route.fulfill({
      body: [
        "interface Array<T> {}",
        "interface Boolean {}",
        "interface CallableFunction extends Function {}",
        "interface Function {}",
        "interface IArguments {}",
        "interface NewableFunction extends Function {}",
        "interface Number {}",
        "interface Object {}",
        "interface RegExp {}",
        "interface String {}",
      ].join("\n"),
      contentType: "text/plain",
    }),
  );
}

async function mockGitHubSource(
  page: import("@playwright/test").Page,
  path: string,
  text: string,
): Promise<void> {
  await mockGitHubSourceFiles(page, [{ path, text }]);
}

async function mockGitHubSourceFiles(
  page: import("@playwright/test").Page,
  files: readonly { readonly path: string; readonly text: string }[],
): Promise<void> {
  await page.route(
    "https://api.github.com/repos/ShaulLavo/Editor/git/trees/main?recursive=1",
    (route) =>
      route.fulfill({
        json: {
          sha: "tree-sha",
          truncated: false,
          tree: files.map((file, index) => ({
            path: file.path,
            type: "blob",
            sha: `file-sha-${index}`,
            size: file.text.length,
          })),
        },
      }),
  );
  for (const file of files) {
    await page.route(
      `https://raw.githubusercontent.com/ShaulLavo/Editor/main/${file.path}`,
      (route) =>
        route.fulfill({
          body: file.text,
          contentType: "text/plain",
        }),
    );
  }
}
