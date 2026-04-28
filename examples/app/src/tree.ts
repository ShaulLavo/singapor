type TreeEntry =
  | { name: string; kind: "file"; handle: FileSystemFileHandle }
  | { name: string; kind: "directory"; handle: FileSystemDirectoryHandle };

export type FileSelectHandler = (filePath: string, content: string) => Promise<void> | void;
type DirectoryToggleHandler = (directoryPath: string, open: boolean) => void;

type RenderDirOptions = {
  prefix?: string;
  selectedPath?: string;
  expandedPaths?: ReadonlySet<string>;
  onDirectoryToggle?: DirectoryToggleHandler;
};

type DirectoryEntryOptions = {
  path: string;
  selectedPath?: string;
  expandedPaths?: ReadonlySet<string>;
  onDirectoryToggle?: DirectoryToggleHandler;
  shouldRestore: boolean;
};

function createTreeEntry(
  name: string,
  child: FileSystemFileHandle | FileSystemDirectoryHandle,
): TreeEntry {
  if (child.kind === "directory") {
    return { name, kind: "directory", handle: child as FileSystemDirectoryHandle };
  }

  return { name, kind: "file", handle: child as FileSystemFileHandle };
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function getDirectorySelectedPath(entryName: string, selectedPath?: string): string | undefined {
  const entryPrefix = `${entryName}/`;
  if (!selectedPath?.startsWith(entryPrefix)) return undefined;
  return selectedPath.slice(entryPrefix.length);
}

async function readDir(handle: FileSystemDirectoryHandle): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];

  try {
    for await (const [name, child] of handle.entries()) {
      entries.push(createTreeEntry(name, child));
    }
  } catch {
    return [];
  }

  return entries.toSorted(compareTreeEntries);
}

function renderDirectoryEntry(
  entry: TreeEntry & { kind: "directory" },
  onFileSelect: FileSelectHandler,
  options: DirectoryEntryOptions,
): { li: HTMLLIElement; restore: Promise<void> | null } {
  const li = document.createElement("li");
  const label = document.createElement("span");
  label.className = "entry directory";
  label.textContent = "📁 " + entry.name;

  let loaded = false;
  let open = false;
  const childContainer = document.createElement("div");
  childContainer.style.display = "none";

  const setOpen = (nextOpen: boolean) => {
    open = nextOpen;
    childContainer.style.display = nextOpen ? "" : "none";
    label.textContent = (nextOpen ? "📂 " : "📁 ") + entry.name;
  };

  const expand = async () => {
    if (!loaded) {
      await renderDir(entry.handle, childContainer, onFileSelect, {
        prefix: options.path,
        selectedPath: options.selectedPath,
        expandedPaths: options.expandedPaths,
        onDirectoryToggle: options.onDirectoryToggle,
      });
      loaded = true;
    }
    setOpen(true);
    options.onDirectoryToggle?.(options.path, true);
  };

  const collapse = () => {
    setOpen(false);
    options.onDirectoryToggle?.(options.path, false);
  };

  const toggle = async () => {
    if (open) {
      collapse();
      return;
    }

    await expand();
  };

  label.addEventListener("click", async () => {
    try {
      await toggle();
    } catch {
      label.classList.add("error");
      return;
    }
  });

  li.append(label, childContainer);

  const restore = options.shouldRestore ? expand() : null;
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
    } catch {
      label.classList.add("error");
      return;
    }
  };

  label.addEventListener("click", selectFile);
  li.appendChild(label);

  const restore = autoSelect ? selectFile() : null;
  return { li, restore };
}

async function appendRenderedEntry(
  ul: HTMLUListElement,
  li: HTMLLIElement,
  restore: Promise<void> | null,
) {
  ul.appendChild(li);
  if (!restore) return;
  await restore;
}

function appendDirectoryEntry(
  ul: HTMLUListElement,
  entry: TreeEntry & { kind: "directory" },
  prefix: string,
  selectedPath: string | undefined,
  onFileSelect: FileSelectHandler,
  options?: RenderDirOptions,
): Promise<void> {
  const path = prefix + entry.name + "/";
  const childSelectedPath = getDirectorySelectedPath(entry.name, selectedPath);
  const shouldRestore = Boolean(childSelectedPath) || Boolean(options?.expandedPaths?.has(path));
  const { li, restore } = renderDirectoryEntry(entry, onFileSelect, {
    path,
    selectedPath: childSelectedPath,
    expandedPaths: options?.expandedPaths,
    onDirectoryToggle: options?.onDirectoryToggle,
    shouldRestore,
  });

  return appendRenderedEntry(ul, li, restore);
}

function appendFileEntry(
  ul: HTMLUListElement,
  entry: TreeEntry & { kind: "file" },
  prefix: string,
  selectedPath: string | undefined,
  onFileSelect: FileSelectHandler,
): Promise<void> {
  const autoSelect = selectedPath === entry.name;
  const { li, restore } = renderFileEntry(entry, prefix, onFileSelect, autoSelect);
  return appendRenderedEntry(ul, li, restore);
}

async function appendTreeEntry(
  ul: HTMLUListElement,
  entry: TreeEntry,
  prefix: string,
  selectedPath: string | undefined,
  onFileSelect: FileSelectHandler,
  options?: RenderDirOptions,
) {
  if (entry.kind === "directory") {
    await appendDirectoryEntry(ul, entry, prefix, selectedPath, onFileSelect, options);
    return;
  }

  await appendFileEntry(ul, entry, prefix, selectedPath, onFileSelect);
}

export async function renderDir(
  dirHandle: FileSystemDirectoryHandle,
  container: HTMLElement,
  onFileSelect: FileSelectHandler,
  options?: RenderDirOptions,
) {
  const prefix = options?.prefix ?? "";
  const selectedPath = options?.selectedPath;

  const entries = await readDir(dirHandle);
  const ul = document.createElement("ul");

  for (const entry of entries) {
    await appendTreeEntry(ul, entry, prefix, selectedPath, onFileSelect, options);
  }

  container.appendChild(ul);
}
