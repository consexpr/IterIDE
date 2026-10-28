# ITER record-then-replay debugger

`DebugManager.start` compiles the editor buffer with `-g -O0`, progressively records
a small test run in the bundled/system GDB, and navigates immutable snapshots. The
renderer is outside this implementation. [API.md](API.md) contains the exact
renderer-facing TypeScript declarations and the removal list.

## Lifecycle and navigation

Start emits `starting`, then `recording` state and `{type:'recording', steps,
done:false}` progress. It publishes the entry or first matching enabled breakpoint
as soon as that snapshot is available; **`start()` returns at this first stop**.
Recording continues in the background. While incomplete, `recordingComplete` is
false and `totalSteps` is the captured frontier, not the eventual trace length.
Progress and the selected state's metadata update every 250 ms or 500 snapshots,
without moving the selection, resetting its frame, or revealing later output.
The final progress event has `done:true`,
elapsed milliseconds and, when applicable, the cap that triggered live fallback.
Compilation, printer discovery, and execution before the first requested stop are
outside `recordingMs` and the recording wall-clock budget. Enabled breakpoints run
natively until the first condition/hit-count match; that stop becomes snapshot zero.
With `stopAtEntry` or no valid enabled breakpoint, snapshot zero is the entry stop.
Cancellation kills GDB and the inferior process trees.

The default budget is 20,000 snapshots or 30,000 milliseconds. Per-start
`recording` options control these limits and aggregate capture bounds. An external
interrupt watchdog handles a step stuck inside a call; interruption adds a small
OS scheduling/helper delay to the time budget. Windows uses the existing
`DebugBreakProcess` helper; Linux sends SIGINT to GDB. On a cap, the inferior stays
alive at the frontier and `mode` is `live`. The recorded prefix remains browsable.
GDB without Python immediately falls back to live MI mode.

`totalSteps` counts snapshots; indices run from zero through `totalSteps-1`.
Normal termination adds a terminal snapshot. A crash adds a final paused signal
snapshot at the innermost user frame, with `final.signal` and a null exit code.
`recordingComplete` means the automatic recording phase finished, including a
capped recording. `recordingEnded` means the inferior exited/crashed within the
available trace. In live mode it becomes true on a subsequent exit/crash.

Initial selection honors `stopAtEntry`; otherwise it selects the first matching
breakpoint, or the terminal snapshot when the complete run has no matching stop.
Code before the recording start has no snapshots and cannot be stepped back into.
Breakpoint hit counts from that execution are retained at snapshot zero.

- `stepIn`: next snapshot, including user-function entries and return sites.
- `stepOver`: next snapshot at the same or lower user-stack depth. A return site
  on the originating call line is skipped, matching native GDB `next`.
  The old `next` command remains an alias for `stepOver`.
  After returning into library code, it skips subsequent callback invocations
  at that depth until the original frame's caller is reached.
- `stepOut`: next snapshot at a lower user-stack depth.
- `stepBack`: exactly index minus one, independently of the last forward command.
- `seek(index)`: select any existing snapshot; wait if the index is beyond the
  current recording frontier. Negative/non-integer indices fail immediately;
  an index beyond a finished/capped recording fails with a range error.
- `continue`: next enabled, condition-matching breakpoint whose hit threshold is
  met. Counts are calculated from the beginning of this trace, so rewinding does
  not accumulate spurious hits. Failed condition evaluation stops with a message
  and `BreakpointInfo.error`, never a fabricated true/false result.
- `runToCursor`: next occurrence of that file/line. A line without code resolves
  using GDB's source symbols; an executable but unvisited branch is never replaced
  by the next _executed_ line.

Forward searches (`stepIn`, `stepOver`, `stepOut`, `continue`, `runToCursor`) wait
for more snapshots until a target is captured or recording finishes/reaches a
limit. An incomplete search never reports a missing target. Already captured
targets and step-back are lookup operations. A newer navigation command cancels
the older pending request (its promise resolves without changing the selection).
Pause also cancels a pending replay navigation without stopping the recorder.
Stop and restart cancel pending navigation and dispose the recording inferior.

When no forward target exists in a complete trace, navigation selects its final
snapshot (exited or signal). Pause is a no-op in replay mode. In the live tail,
movements use native GDB, append snapshots and retain backward lookup. Outermost
live step-out stays paused with a Chinese message. Editing breakpoints while
live execution runs interrupts it and leaves it paused after synchronization.
Restart of a complete replay reuses the trace; restart of an incomplete/capped/live
run records again. Restart applies the same initial selection and reason as start:
a matching breakpoint reports `breakpoint`; explicit entry reports `entry`.
Stop discards the session and its private build/trace files.

## Capture and exact values

`recorder.ts` runs the source-step loop inside GDB Python, avoiding an MI round
trip per local/frame. Each complete snapshot is flushed to the private NDJSON
trace. Node tails new bytes in bounded chunks with a streaming UTF-8 decoder;
it never repeatedly rereads the growing trace. Automatic user-function discovery
walks the main compilation unit's global/static symbol blocks, including user
headers and instantiated callbacks. Multi-source graders retain exhaustive
function discovery for GDB versions without other-unit symbol enumeration.
It automatically finishes non-user library frames and keeps
stepping on a call line after a library return, so `add(sum,a[i])` enters `add`.
Internal finish breakpoints preserve the exact caller return sites needed by
step-out. Internal user-function entry breakpoints also catch callbacks inside
finished library calls (for example a user `std::sort` comparator). Recording
starts at the first matching breakpoint, or at `main` for an entry stop; static
initialization has already run. User files include the
original source directory and additional build
units returned by judge-mode build hooks (including graders outside that directory).

Each stop records all stack levels, locals for each user frame, source globals
found through identifiers in the editor buffer, signal/exit information and byte
offsets. Globals use names such as `::g` and `scope:'global'` in `locals()`;
locals use `scope:'local'`. Qualified globals remain addressable despite shadowing.
Compiler-generated range-for temporaries are excluded unless explicitly named
in the source. Frame selection changes locals/evaluation/expansion and paused
`frame`; navigation resets selection to the innermost user frame.

Numeric scalar values are read from GDB without display rounding. Scalars carry
internal exact integer/float metadata; summaries are never parsed as numbers.
Aggregates default to 200 children, three aggregate levels and 2,000 captured
nodes per snapshot. `truncated` and `unavailable` explicitly distinguish omissions
and read failures. Pointer addresses are retained; pointers are not eagerly
dereferenced. Strings and large aggregates retain bounded display summaries.
Uninitialized locals reflect what GDB reads; they are not initialized by ITER.

Trace files intern immutable variable nodes by their complete serialized
descriptors, with child references. Unchanged arrays/elements/frame values are
shared exactly, without a lossy comparison. Reconstruction checks every reference.

`expression.ts` handles identifiers, captured array/vector/deque indexing,
members, integer/float/ASCII char literals, parentheses, arithmetic, comparisons
and short-circuit Boolean operations. Integers use BigInt, C++ promotions and
unsigned wrapping. Signed overflow, target-dependent `long` literals, enum
arithmetic, pointers, missing/truncated elements, casts and function calls go to
GDB. No JavaScript `eval` is used.

Condition results/hit prefixes are filled when recording completes and when
breakpoints are created/edited. Unsupported conditions can make an edit slower
because each required visit must be sought exactly. Browsing an existing snapshot
never waits for this work: exact hit-count/verification events may arrive later,
and a superseded selection cannot publish stale counts. `breakpoints()` waits
for the selected snapshot's exact counts; condition-based navigation waits for
any required exact evaluation. No provisional count or condition result is emitted.
The live tail reports native condition-matching visits, including ignored visits
between its recorded toolbar stops. Changing a condition recalculates the retained
trace; unrecorded live intervals cannot be retroactively filtered by a new condition.

An unresolved query performs a deterministic native seek, first trying a line
breakpoint with an earlier-visit ignore count. A lazy second GDB process imports
the captured position/fingerprint prefix and uses an isolated run directory and IO
files, both during recording and after it finishes. Neither conditions nor user
queries can restart/mutate the recording/live inferior or overwrite its output.
Its query queue is independent of live movements, so a slow historical inspection
does not hold up Continue or stepping. Both processes are disposed on stop/restart.
The complete frame stack, symbolic user PCs, captured value fingerprint and
output bytes must match. If the fast path misses, it replays the exact source
movements (including live-tail commands and their breakpoint definitions).
Mismatches/timeouts are reported; a nearby line or guessed value is never accepted.
Seek failures leave the visible replay snapshot intact. Query results are cached
by snapshot, frame, expression and child path. Concurrent native queries serialize.

`children(ref)` uses captured children when complete; otherwise it queries that
root/child path at the exact stop. Each returned expansion is still bounded by
the configured caps. An uncaptured element can be queried directly, e.g.
`evaluate('a[900]')`. References belong to a snapshot and cannot expand a different
timeline position. Query function calls/assignments affect only the disposable
seeker state; the next uncached query restores the snapshot. They do not edit the
recorded run. Failed queries return null (or a rejected child-expansion request)
and a paused diagnostic where applicable.

## Output, input, builds and cleanup

Every navigation emits `{type:'output', stdout, stderr, stdoutOffset,
stderrOffset}`. **Replace** both panes with these strings; do not append them.
Offsets are UTF-8 byte counts, not JavaScript string lengths. Stdout includes
normal capture followed by configured file-output text, as in the previous
debugger. An unfinished UTF-8 sequence is withheld until complete. Legacy
`stdout`/`stderr` append event variants remain in the contract but navigation uses
the replacement event. Live execution publishes replacement output periodically.

The recorder journals output byte changes, including resets/overwrites. Persistent
chunks reconstruct old output exactly without full copies at every stop. Background
seeks emit no duplicate/restarted program output and verify output before reading
uncaptured values. Internal GDB streams and thread notifications are never exposed.

The existing prelude redirects stdin/stdout/stderr through environment variables,
supports both C and C++ IO, and avoids shell/PTY redirection differences on Windows.
Input comes from the explicit request or the selected stored test. Configured
file input/output stay inside the private run cwd and reset during native seeks.
Editor-buffer `#line` mapping, compiler-relative libstdc++ printers, judge-mode
additional sources/include paths, and process-tree cleanup remain in use. Debug
flags `-g -O0` are appended after mode/problem flags. No source file is overwritten.

## Limits and verification

Exact on-demand reconstruction assumes deterministic execution with the same
input. Time/randomness, threads, external state and manually timed live pauses
can diverge. Captured values remain exact; uncaptured queries refuse a detected
stack/value/output mismatch. Pointer/ASLR differences can conservatively reject
a seek. External program side effects are not rolled back. The debugger does not
prove determinism of memory that was never captured. This is intended for small,
single-threaded OI runs.

Globals currently cover named global/static symbols referenced lexically in the
editor buffer; macro-generated names and anonymous-namespace/debug-info omissions
may require an explicit GDB-backed expression. Without GDB Python, live MI has
bounded locals/children but no automatic whole-run/global capture. Live step-back
is exact for recorded positions; reconstructing a manually timed pause may fail.
Native seeks have a 60-second guard; live movement has a ten-minute guard and can
be interrupted/stopped earlier. Traces remain private session data and are not a
persistent/export format.

Run:

```sh
npx tsc -p src/main/debug/tsconfig.node.json
npx vitest run src/main/debug
```

The node config excludes the renderer being updated in parallel. Real bundled
MinGW GDB tests cover native step/next/finish equivalence, loops, recursion,
vectors, globals/nested arrays, exact truncated-data seeks, selected frames,
breakpoint conditions/hit counts/errors, cin, crashes, file IO/grader builds,
time/step caps, pause, Python-less MI and output rewinds/overwrites. Progressive
tests cover early conditional stops, future seeks/searches, cancellation,
restart/stop cleanup, edits during pending continue, isolated exact queries,
instant browsing while hit counts are pending, and callbacks in user headers.
Benchmarks
in `manager.test.ts` print recording time and lookup-navigation latency. Linux
uses the same GDB Python/MI implementation; this Windows verification does not
constitute a Linux runtime test.

Measured on Windows 11 with bundled MinGW GDB, 2026-10-20. First-stop times
include compilation and GDB initialization; navigation excludes Electron IPC and
rendering. These are individual runs, with printer discovery cached in the full
suite. The A2 benchmark embeds sandbox/A2.cpp's source/line layout and input
`3\n3 1 2\n`, with a breakpoint on line 15 (the earlier baseline used the same
program with fewer blank lines). The loop breakpoint is early in main.

| Program              | Snapshots | First stop before → after | Complete GDB recording before → after | Backend navigation after                    |
| -------------------- | --------: | ------------------------: | ------------------------------------: | ------------------------------------------- |
| A2                   |        21 |         3.350 s → 2.135 s |                     1.219 s → 0.219 s | median 0.0057 ms; p95 0.0194 ms (100 seeks) |
| 5,000-iteration loop |    10,005 |        13.707 s → 1.207 s |                   12.547 s → 11.594 s | seek to index 9,000: 0.0600 ms              |

Python profiling identified about **1,000 ms in whole-program function discovery**,
inside the original A2 step loop. Direct symbol traversal removes that fixed cost
for a single compilation unit. Representative remaining phases: GDB startup and
symbols 60 ms, cached printer registration 69 ms, script setup 58 ms, inferior
startup 94 ms. Aggregate capture still reads the configured bounded trees at every
stop; there is no guessed change detection, lazy scalar omission or per-stop MI
var-create. Profiling timings inside older Windows GDB Python have coarse clock
resolution. Multi-source graders retain the slower exhaustive discovery path.

Final verification: 78 tests across five files and the node-side typecheck pass.
Renderer files/typechecking are outside this follow-up; no shared/API/bridge
contract changed. `start()` resolving at the first stop is the lifecycle change.

## Modules

- `manager.ts`: build/session ownership, abort and public bridge methods.
- `session.ts`: trace navigation, frames/references, virtual breakpoints and caches.
- `native.ts`: GDB lifecycle, synchronization, native seek/query/live adapter.
- `recorder.ts`: packaged inline GDB Python capture/stepping/serialization.
- `trace.ts`, `output.ts`, `expression.ts`: immutable trace data, output and exact evaluator.
- `build.ts`, `process.ts`, `pretty-printers.ts`: existing platform/build integration.
- `mi.ts`, `mi-client.ts`, `value-summary.ts`: tested MI transport and Python-less fallback.
