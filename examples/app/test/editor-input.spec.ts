import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const coreEntry = `/@fs/${fileURLToPath(
  new URL("../../../packages/editor/src/editor.ts", import.meta.url),
)}`;

type TestWindow = Window & {
  __editor?: {
    focus(): void;
    getText(): string;
  };
  __editorInputEvents?: string[];
};

async function installInputEventProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const input = document.querySelector(".editor-virtualized-input");
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("Missing editor input");

    (window as TestWindow).__editorInputEvents = [];
    input.addEventListener(
      "beforeinput",
      (event) => {
        const inputEvent = event as InputEvent;
        (window as TestWindow).__editorInputEvents?.push(
          `beforeinput:${inputEvent.inputType}:${inputEvent.data ?? ""}`,
        );
      },
      { capture: true },
    );
  });
}

test("routes real keyboard typing after clicking the editor surface", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (entry) => {
    const { Editor } = await import(entry);
    const app = document.querySelector("#app");
    if (!app) throw new Error("Missing app root");

    app.innerHTML = '<div id="host" style="display:flex;height:300px;width:700px"></div>';
    const host = document.querySelector("#host");
    if (!(host instanceof HTMLElement)) throw new Error("Missing editor host");

    const editor = new Editor(host);
    editor.openDocument({ documentId: "note.txt", text: "abc" });
    (window as TestWindow).__editor = editor;
  }, coreEntry);
  await installInputEventProbe(page);

  await page.locator(".editor-virtualized").click({ position: { x: 80, y: 10 } });
  await expect(page.locator(".editor-virtualized-input")).toBeFocused();

  await page.keyboard.type("XYZ");

  await expect
    .poll(() => {
      return page.evaluate(() => (window as TestWindow).__editor?.getText());
    })
    .toBe("abcXYZ");
  await expect
    .poll(() => {
      return page.evaluate(() => (window as TestWindow).__editorInputEvents ?? []);
    })
    .toContain("beforeinput:insertText:X");
});

test("inserts repeated typing at a placed caret", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (entry) => {
    const { Editor } = await import(entry);
    const app = document.querySelector("#app");
    if (!app) throw new Error("Missing app root");

    app.innerHTML = '<div id="host" style="display:flex;height:300px;width:700px"></div>';
    const host = document.querySelector("#host");
    if (!(host instanceof HTMLElement)) throw new Error("Missing editor host");

    const editor = new Editor(host);
    editor.openDocument({ documentId: "note.txt", text: "abcdef" });
    (window as TestWindow).__editor = editor;
  }, coreEntry);
  await installInputEventProbe(page);

  await page.locator(".editor-virtualized").click({ position: { x: 59, y: 10 } });
  await expect(page.locator(".editor-virtualized-input")).toBeFocused();

  await page.keyboard.type("XYZ");

  await expect
    .poll(() => {
      return page.evaluate(() => (window as TestWindow).__editor?.getText());
    })
    .toBe("abcXYZdef");
  await expect
    .poll(() => {
      return page.evaluate(() => (window as TestWindow).__editorInputEvents ?? []);
    })
    .toContain("beforeinput:insertText:X");
});

test("routes native line break input at a placed caret", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (entry) => {
    const { Editor } = await import(entry);
    const app = document.querySelector("#app");
    if (!app) throw new Error("Missing app root");

    app.innerHTML = '<div id="host" style="display:flex;height:300px;width:700px"></div>';
    const host = document.querySelector("#host");
    if (!(host instanceof HTMLElement)) throw new Error("Missing editor host");

    const editor = new Editor(host);
    editor.openDocument({ documentId: "note.txt", text: "abcdef" });
    (window as TestWindow).__editor = editor;
  }, coreEntry);
  await installInputEventProbe(page);

  await page.locator(".editor-virtualized").click({ position: { x: 59, y: 10 } });
  await expect(page.locator(".editor-virtualized-input")).toBeFocused();

  await page.keyboard.press("Enter");

  await expect
    .poll(() => {
      return page.evaluate(() => (window as TestWindow).__editor?.getText());
    })
    .toBe("abc\ndef");
  await expect
    .poll(() => {
      return page.evaluate(() => (window as TestWindow).__editorInputEvents ?? []);
    })
    .toContain("beforeinput:insertLineBreak:");
});

test("focuses the editor for typing after loading a GitHub source file", async ({ page }) => {
  await mockGitHubSource(page, "README.md", "abc");
  await page.goto("/");

  await expect(page.locator(".entry.file")).toContainText("README.md");
  await page.locator(".entry.file").click();
  await expect(page.locator(".editor-virtualized-input")).toBeFocused();

  await page.keyboard.type("XYZ");

  await expect(page.locator(".editor-virtualized")).toContainText("abcXYZ");
});

async function mockGitHubSource(page: Page, path: string, text: string): Promise<void> {
  await page.route(
    "https://api.github.com/repos/ShaulLavo/Editor/git/trees/main?recursive=1",
    (route) =>
      route.fulfill({
        json: {
          sha: "tree-sha",
          truncated: false,
          tree: [{ path, type: "blob", sha: "file-sha", size: text.length }],
        },
      }),
  );
  await page.route(`https://raw.githubusercontent.com/ShaulLavo/Editor/main/${path}`, (route) =>
    route.fulfill({
      body: text,
      contentType: "text/plain",
    }),
  );
}

test("preserves scroll when refocusing a scrolled editor", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (entry) => {
    const { Editor } = await import(entry);
    const app = document.querySelector("#app");
    if (!app) throw new Error("Missing app root");

    app.innerHTML = [
      '<button id="outside">Outside</button>',
      '<div id="host" style="display:flex;height:160px;width:700px"></div>',
    ].join("");
    const host = document.querySelector("#host");
    if (!(host instanceof HTMLElement)) throw new Error("Missing editor host");

    const editor = new Editor(host);
    const text = Array.from({ length: 200 }, (_value, index) => `line ${index}`).join("\n");
    editor.openDocument({ documentId: "note.txt", text });
    (window as TestWindow).__editor = editor;

    const root = document.querySelector(".editor-virtualized");
    if (!(root instanceof HTMLElement)) throw new Error("Missing editor root");
    root.scrollTop = 900;
  }, coreEntry);

  await page.locator("#outside").focus();
  await page.evaluate(() => {
    (window as TestWindow).__editor?.focus();
  });
  await page.waitForTimeout(50);

  await expect
    .poll(() => page.evaluate(() => document.querySelector(".editor-virtualized")?.scrollTop))
    .toBe(900);
});
