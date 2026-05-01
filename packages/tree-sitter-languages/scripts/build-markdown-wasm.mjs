import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const grammarRoot = join(
  packageRoot,
  "node_modules",
  "@tree-sitter-grammars",
  "tree-sitter-markdown",
);
const outputRoot = join(packageRoot, "src", "grammars");
const treeSitterBin = join(packageRoot, "node_modules", ".bin", "tree-sitter");

const grammars = [
  ["tree-sitter-markdown", "tree-sitter-markdown.wasm"],
  ["tree-sitter-markdown-inline", "tree-sitter-markdown-inline.wasm"],
];

mkdirSync(outputRoot, { recursive: true });

for (const [grammarDir, outputFile] of grammars) {
  buildGrammar(grammarDir, outputFile);
}

function buildGrammar(grammarDir, outputFile) {
  const result = spawnSync(
    treeSitterBin,
    [
      "build",
      "--wasm",
      "--docker",
      join(grammarRoot, grammarDir),
      "-o",
      join(outputRoot, outputFile),
    ],
    { stdio: "inherit" },
  );

  if (result.status === 0) return;

  const status = result.status ?? 1;
  process.exit(status);
}
