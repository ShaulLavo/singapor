# Phase 0 Architecture Health

This directory is the Phase 0 baseline for `docs/architecture-recovery-plan.md`.
It is intentionally descriptive before it is aspirational: the files here record the current knots so
future changes can make them smaller deliberately.

## Command

Run the guardrail check from the repository root:

```bash
bun run health
```

Regenerate baselines only when the architecture change is intentional and reviewed:

```bash
bun run health:write
```

The CI workflow `.github/workflows/architecture-health.yml` runs `bun run health` on pull requests,
pushes to `main`, and manual dispatch.

## What The Check Measures

- Ignored local source mirrors: `.desloppify`, `node_modules`, `opensrc`, `references`, build output,
  and VCS/cache directories are excluded from health source scans.
- Package-level cycles between workspace packages.
- Source-level import cycles in `packages/editor/src`, editor virtualization, `packages/lsp/src`,
  `packages/lsp-plugin/src`, and `packages/typescript-lsp/src`.
- Missing package scripts for the root Turborepo contract: `build`, `test`, `typecheck`, `lint`,
  `format`, and `format:check`.
- Duplicate LSP module candidates between `@singapor/lsp-plugin` and `@singapor/typescript-lsp`.
- The current `@singapor/core` public export inventory.
- Production timer usage that must stay justified until Phase 3 scheduling work replaces it.

## Current Known Issues

- Package cycles: none reported in the Phase 0 baseline.
- Source cycles: editor/plugin/virtualization cycles remain in `@singapor/core`, and one client/workspace
  cycle remains in `@singapor/lsp`.
- Duplicate modules: the LSP plugin and TypeScript-LSP packages share 18 same-name modules.
- Package scripts: 14 workspace packages are missing at least one expected script, mostly `build` and
  package-level `test`.
- Public API leaks: `@singapor/core` still exposes broad `export *` surfaces from document, piece-table,
  syntax, display, theme, plugin, and virtualization internals. Phase 1 owns containment.
- Timers: 32 production timer or frame/idle/microtask usages are accepted only as a Phase 0 legacy
  baseline. New timer entries require a scheduler justification in `timer-usage.json`.

## Review Rules

- New public `@singapor/core` exports must update `core-public-api.json` in the same reviewed change.
- New production timers must update `timer-usage.json` with a specific justification. Leaving the
  generated `TODO` text makes `bun run health` fail.
- Fixed cycles, removed exports, or deleted timers should update the baseline in the same change so
  the checked-in files continue to describe reality.
- Source mirrors belong in `opensrc/` or `references/`; they must not be added under package source
  roots.

## Baseline Files

- `health-baseline.json` records package cycles, source cycles, duplicate modules, ignored roots, and
  missing package scripts.
- `core-public-api.json` records `@singapor/core` package entry points and exported names.
- `timer-usage.json` records production timer usage and required justifications.
- `performance-baseline.md` records the first reproducible performance numbers for Phase 0.
