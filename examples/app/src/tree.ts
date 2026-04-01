type TreeEntry =
  | { name: string; kind: "file"; handle: FileSystemFileHandle }
  | { name: string; kind: "directory"; handle: FileSystemDirectoryHandle };

type FileSelectHandler = (filePath: string, content: string) => Promise<void> | void;

async function readDir(handle: FileSystemDirectoryHandle): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  try {
    for await (const [name, child] of handle.entries()) {
      if (child.kind === "directory") {
        entries.push({ name, kind: "directory", handle: child as FileSystemDirectoryHandle });
      } else {
        entries.push({ name, kind: "file", handle: child as FileSystemFileHandle });
      }
    }
  } catch (err) {
    console.error(`Failed to read directory "${handle.name}":`, err);
    return [];
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function renderDirectoryEntry(
  entry: TreeEntry & { kind: "directory" },
  prefix: string,
  onFileSelect: FileSelectHandler,
  restorePath?: string,
): { li: HTMLLIElement; restore: Promise<void> | null } {
  const li = document.createElement("li");
  const label = document.createElement("span");
  label.className = "entry directory";
  label.textContent = "📁 " + entry.name;

  let loaded = false;
  let open = false;
  const childContainer = document.createElement("div");
  childContainer.style.display = "none";

  const expand = async (subPath?: string) => {
    if (!loaded) {
      await renderDir(entry.handle, childContainer, onFileSelect, {
        prefix: prefix + entry.name + "/",
        selectedPath: subPath,
      });
      loaded = true;
    }
    open = true;
    childContainer.style.display = "";
    label.textContent = "📂 " + entry.name;
  };

  label.addEventListener("click", async () => {
    if (open) {
      open = false;
      childContainer.style.display = "none";
      label.textContent = "📁 " + entry.name;
    } else {
      try {
        await expand();
      } catch (err) {
        console.error(`Failed to expand directory "${entry.name}":`, err);
        label.classList.add("error");
      }
    }
  });

  li.append(label, childContainer);

  const restore = restorePath ? expand(restorePath) : null;
  return { li, restore };
}

function renderFileEntry(
  entry: TreeEntry & { kind: "file" },
  prefix: string,
  onFileSelect: FileSelectHandler,
  autoSelect: boolean,
): { li: HTMLLIElement; restore: Promise<void> | null } {
  const li = document.createElement("li");
  const label = document.createElement("span");
  label.className = "entry file";
  label.textContent = "📄 " + entry.name;

  const selectFile = async () => {
    document.querySelectorAll(".entry.active").forEach((el) => el.classList.remove("active"));
    label.classList.add("active");
    try {
      const file = await entry.handle.getFile();
      await onFileSelect(prefix + entry.name, await file.text());
    } catch (err) {
      console.error(`Failed to read file "${entry.name}":`, err);
      label.classList.add("error");
    }
  };

  label.addEventListener("click", selectFile);
  li.appendChild(label);

  const restore = autoSelect ? selectFile() : null;
  return { li, restore };
}

export async function renderDir(
  dirHandle: FileSystemDirectoryHandle,
  container: HTMLElement,
  onFileSelect: FileSelectHandler,
  options?: { prefix?: string; selectedPath?: string },
) {
  const prefix = options?.prefix ?? "";
  const segments = options?.selectedPath?.split("/");
  const targetName = segments?.[0];
  const isLeaf = segments?.length === 1;

  const entries = await readDir(dirHandle);
  const ul = document.createElement("ul");

  for (const entry of entries) {
    const isTarget = entry.name === targetName;

    if (entry.kind === "directory") {
      const restorePath =
        isTarget && !isLeaf && segments ? segments.slice(1).join("/") : undefined;
      const { li, restore } = renderDirectoryEntry(entry, prefix, onFileSelect, restorePath);
      ul.appendChild(li);
      if (restore) await restore;
    } else {
      const { li, restore } = renderFileEntry(entry, prefix, onFileSelect, isTarget && !!isLeaf);
      ul.appendChild(li);
      if (restore) await restore;
    }
  }

  container.appendChild(ul);
}
