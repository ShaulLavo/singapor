# Repeatable Editor stress benchmarks

Run from the repository root with Node 26 and Bun installed:

```sh
bun install --frozen-lockfile
bun run bench:stress --output /work/tmp/editor-stress/control-1.json --verify-cancellation
bun run --cwd examples/stress test
```

`bench:stress` builds the public package exports first. The runner then builds this standalone
Vite entry into a temporary directory under `/work/tmp`, launches installed Playwright Chromium,
and serves the build through Playwright request routing. It opens no listening socket and starts
no dev server. It deletes the build and browser profile on success, failure, SIGINT, or SIGTERM.
No corpus download or fixture generation is part of a timing interval.

For interactive work, open this entry through an already running Vite server and supply its URL
with `--url`. That delivery mode is recorded and cannot be compared with the built runner.
Install Chromium separately if it is missing, with Playwright's browser cache on a data drive.

## Runner inventory

| Workload                        | Runner                                                 | Boundary / decision                                                                              |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Anchor resolution and insertion | `packages/editor` `bench:anchors`, `bench:piece-table` | Keep storage microbenchmarks and their distinct edit histories.                                  |
| Display transforms and folds    | `bench:transforms`, `bench:fold-map`                   | Keep focused algorithm workloads.                                                                |
| Row and long-line mounting      | `bench:virtualization`                                 | Keep happy-dom allocation/count checks; it does not measure browser paint.                       |
| Piece traversal                 | `bench:walker`                                         | Keep sequential/random-access comparisons.                                                       |
| Parsing, queries, injections    | `packages/tree-sitter` `bench:syntax`                  | Keep worker timing and process memory measurements.                                              |
| Application open / filesystem   | Platform `editor-open-benchmark.mjs`                   | Remains Platform-owned; this suite starts before `createEditorTextBuffer` and view construction. |
| Application typing              | Platform `editor-typing-benchmark.mjs`                 | Retain its trusted-key timestamp to applied-edit / next-frame definition here.                   |
| Full standalone scenarios       | `examples/stress` `bench`                              | Open, highlight, jump, typing, find-all, wheel sweeps, edit/delete retention.                    |

The older generators exercise different algorithms, sizes, and edit distributions. None is an
equivalent caller of the new corpus, so none was deleted or silently changed. Future users can
generate the common corpus with `bun run --cwd examples/stress fixtures /work/tmp/editor-fixtures`.
Without a directory argument, that command prints only the manifest. Generated documents do not
belong in Git. `results/manifest.json` pins the seed, generator version, UTF-8 bytes, UTF-16 length,
normalized line count, longest line, search count, and SHA-256 for every fixture.

## Measurements and correctness

Every fixture runs every scenario. The ordinary open also enables the real TypeScript Tree-sitter
plugin and requires its authoritative highlighted generation and colored screenshot pixels. The
other scenarios use plain text rendering; syntax throughput already has its own worker benchmark.
These feature choices are part of the comparable configuration.

Each sample owns a fresh buffer and views, input listener, and frame callbacks. Churn uses two
visible views and one hidden view sharing one buffer, records 100 insert/delete cycles in history,
checks exact text in all three, and reveals the hidden view before releasing everything. The
runner also observes collection of the buffer and Editor objects through weak references after
forced GC. Cold samples use a fresh browser context; warm samples follow an unrecorded repetition
in the same context. Warm never means retaining the previous document or its event handlers.
Cold is a fresh JavaScript context, not a flushed OS cache or a restarted browser process.
Interaction setup waits for a captured text paint before issuing input, so initial viewport
measurement does not race a warm typing run. Churn checks the inserted Unicode prefix and all
200 document revisions. Two additional untimed probe edits prove visible and hidden views update.

Open/jump/scroll/burst paint values are **upper bounds ending at screenshot completion**, including
Playwright transport and capture cost. Pixel checks reject blank text and missing syntax color.
They prove captured browser output, not physical monitor presentation or the exact first painted
frame. `keyToFrame` preserves Platform's next-animation-frame observable and is explicitly not
pixel evidence. Screenshot costs do not enter `attach`, `keyToApplied`, or churn throughput.
Find uses trusted keyboard input and requires the exact expected match count with no truncation.
Scroll uses trusted wheel events and validates rendered rows against the generated document.

Latency arrays and throughput are separate. Chromium memory reports main-renderer CDP heap bytes and DOM/node/
listener counts after forced GC, plus live post-churn memory and released object counts. Process
RSS and `measureUserAgentSpecificMemory` are explicitly unsupported, never zero placeholders.
Worker heap bytes are not measured by the page CDP session. Language workers may keep their runtime
cache within a warm scenario group; closing its context releases them before the next scenario.
GC does not make heap usage a portable metric across engines. Chromium is the only reference
engine in version 1; other engines need their own implementation and control evidence.

Use `--diagnostics` to attach the existing `__EDITOR_PERFORMANCE_DIAGNOSTICS__` sink. Ordinary runs
leave it disabled. Diagnostic runs are separate configurations and cannot enter production
comparisons. No additional timing hooks were added to core subsystems.

## Controls and comparison

```sh
bun run bench:stress --output /work/tmp/editor-stress/control-1.json --verify-cancellation
bun run bench:stress --output /work/tmp/editor-stress/control-2.json
bun run bench:stress --output /work/tmp/editor-stress/control-3.json
bun run --cwd examples/stress compare calibrate /work/tmp/editor-stress/limits.json /work/tmp/editor-stress/control-1.json /work/tmp/editor-stress/control-2.json /work/tmp/editor-stress/control-3.json
bun run bench:stress --output /work/tmp/editor-stress/rerun.json
bun run --cwd examples/stress compare check /work/tmp/editor-stress/control-1.json /work/tmp/editor-stress/rerun.json /work/tmp/editor-stress/limits.json
```

The local envelope is derived separately for each fixture/scenario/state/metric. The p50 limit
is the largest control median plus the greater of three times the between-run median spread or
the observed within-run p95-minus-median spread. The p95 limit is the largest control p95 plus
three times the greater of the between-run median and p95 spreads. Raw controls and calculated
limits remain inspectable. These are exploratory local tolerances, not installed CI thresholds.
Choose stable reference hardware, increase repetitions, and measure control stability before
using a result to block CI. Do not claim an improvement until an unchanged rerun compares cleanly.
Resource limits use the largest control maximum plus three times the spread of control maxima,
separately for heap bytes, DOM nodes, listeners, tracked objects, and live post-churn heap bytes.

The comparator rejects missing/duplicate samples, invalid timings, fixture hash differences,
different browser/hardware/features, and missing calibration coverage. Tests prove unchanged
comparison, slowdown detection, deterministic fixtures, real Unicode edits, and mixed endings.
`--verify-cancellation` cancels a running asynchronous churn scenario and checks released resources.
After recording controls, `bun run --cwd examples/stress proof` replays the checked comparison,
verifies that limits derive from those controls, and proves rejection of missing samples, changed
hashes/options, and synthetic latency and memory regressions applied to the recorded raw samples.
Its `contractsPassed` field covers those verification checks; `calibrationStable` separately reports
the independent unchanged run. The checked developer-machine calibration is still noisy. See
[the local baseline](results/README.md) for both unchanged-run outcomes. Do not use its limits in CI.

Useful options: `--repetitions 3`, `--warmups 1`, `--seed 60061`, `--fixtures ordinary`,
`--diagnostics`, and `--output PATH`. A subset cannot compare against the complete fixture set.
Scenario failures write a structured event with fixture, state, observation, and error. A failed
or interrupted run does not replace the requested result file.

## CPU profiling

Use a fresh profile directory for each run:

```sh
bun run bench:stress --fixtures ordinary,long-line --repetitions 1 --profile-directory /work/tmp/editor-line-profile --output /work/tmp/editor-line-profile/result.json
bun run --cwd examples/stress profile:summary /work/tmp/editor-line-profile > /work/tmp/editor-line-profile/summary.jsonl
```

The runner records Chromium CPU profiles at a requested 1 ms sampling interval around typing and
churn, after initial text paint. Each recorded cold and warm repetition writes a `.cpuprofile`.
Warmup repetitions are not profiled. The saved `build/` includes readable JavaScript and composed
TypeScript source maps. Import a profile in Chrome DevTools Performance to explore its stacks,
or use `profile:summary` for source locations and weighted self and inclusive samples.

Profiles include interaction setup, correctness checks, screenshots, and churn's two probe edits.
They exclude fixture generation, initial attachment, and disposal. The summary removes idle samples
from active percentages and counts a recursive function only once per inclusive stack. Inclusive
percentages overlap across callers. Sampling weights are approximate, and native browser work is
not fully attributed by the JavaScript profiler.

Profiling disables minification and records a distinct configuration. Do not compare these timings
against the normal benchmark calibration. The existing-server `--url` mode is unsupported because
it cannot preserve the matching build. A profile directory must not already exist, preventing stale
traces from mixing with a new run. Profiles remain available after a failed scenario.

See [the long-line investigation](results/long-line-profile.md) for the measured hot paths and
[the implemented fixes](results/long-line-fix.md) for normal-build before/after measurements,
regression coverage, and the memory tradeoff.
