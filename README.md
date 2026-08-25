# hermes-probe

A minimal TypeScript probe of two JS runtime internals:

- **Part A** — memory/GC behavior: allocate and release objects in a few
  characteristic patterns (including a WeakMap / reference-cycle case),
  sample heap usage over time, print a growth table.
- **Part B** — multithreading: run a CPU-bound task single-threaded vs across
  `worker_threads`, synchronized with `SharedArrayBuffer` + `Atomics`, and
  measure throughput/speedup.

Everything here was actually executed on this machine (Node v26, Apple M5,
10 logical cores) — the numbers in "Findings" are real output, not estimates.

## Layout

```
src/
  memory/
    types.ts          sample shape
    gc.ts              forceGC() wrapper around global.gc()
    patterns.ts        the four allocate/release patterns
    run-node.ts         Node/V8 runner: samples, prints table, writes CSV
    hermes/
      probe.hermes.ts   standalone, import-free variant for the Hermes engine
  threads/
    task.ts             the CPU-bound work (prime counting)
    worker.ts            worker_threads entry point
    benchmark.ts          orchestrator: baseline + N-worker runs, prints table, writes CSV
scripts/
  run-memory.sh
  run-threads.sh
results/
  memory-latest.csv     checked-in sample output of the last run
  threads-latest.csv
```

## Running it

```sh
npm install

./scripts/run-memory.sh          # Part A, Node/V8
./scripts/run-threads.sh         # Part B
```

Both scripts just `tsc` build then run the compiled output; they're the
"small script to run each part" — `npm run memory` / `npm run threads` are
equivalent aliases in `package.json`.

Both parts are parameterized by environment variables for reproducing at a
different scale:

```sh
HERMES_PROBE_COUNT=500000 ./scripts/run-memory.sh

HERMES_PROBE_RANGE=8000000 HERMES_PROBE_CHUNK=4000 HERMES_PROBE_WORKERS=1,2,4,8 \
  ./scripts/run-threads.sh
```

Each run overwrites `results/{memory,threads}-latest.csv` and also drops a
timestamped `*-run-*.csv` (gitignored — local scratch, not checked in) next
to it.

---

## Part A — memory / GC probe

### Memory model

Both engines targeted here (V8 under Node, and — in spirit — Hermes on
React Native) use **tracing garbage collection**, not reference counting.
Reachability is computed by walking object graphs from roots (globals, the
stack, closures); anything unreached is garbage, *regardless of whether it
contains cycles*. This matters because the classic "circular references
leak memory" folklore comes from refcounting systems (old COM/IE, manual
retain/release); it does not apply to V8 or Hermes. `patterns.ts` proves
this directly with the `weakmap-cycle` case below.

`WeakMap` (and `WeakSet`/`WeakRef`) sit on top of the same tracing collector
via **ephemeron** semantics: an entry's value is only kept alive as long as
its key is reachable *through some other strong path*; the map itself never
counts as that path. So a `WeakMap` doesn't need an explicit `.delete()` —
once nothing outside the map still points at the key, the entry (and
anything only the value graph strongly holds) becomes collectible on the
next GC pass. A plain `Map` gives no such thing: it strongly holds every
key and value it was given until you call `.delete()`/`.clear()`, no matter
how unreachable those entries are from the rest of the app.

### GC strategy

- **V8 (Node)**: generational. A copying scavenger ("Scavenger") handles a
  small young generation (bump-pointer allocation, cheap because most
  objects die young); objects that survive get promoted to the old
  generation, collected by an incremental/concurrent mark-sweep-compact
  pass ("Orinoco"/Major GC) so a full collection doesn't have to stop the
  world for long. `global.gc()` (only available with `node --expose-gc`)
  forces a synchronous full collection — used here specifically so sampling
  is deterministic instead of depending on V8's normal lazy/heuristic
  scheduling.
- **Hermes**: also generational and tracing. Since the "Hades" collector
  became the default, the old generation is collected mostly
  concurrently/incrementally off the JS thread specifically to avoid the
  multi-millisecond stop-the-world pauses that show up as dropped frames in
  a React Native app; the young generation is a small bump-pointer nursery,
  same rationale as V8's scavenger. Both engines optimize for the same
  observation ("most objects die young") with the same generational-hypothesis
  design, which is why the four patterns below produce the same qualitative
  shape on either engine even though this repo only measured them on V8.

### The four patterns (`src/memory/patterns.ts`)

1. **`array-churn`** — push N plain objects into a local array, drop the
   reference, force GC. Baseline allocate/release.
2. **`map-cache`** — insert N entries into a `Map` (a stand-in for an
   in-memory cache), then explicitly `.clear()` it. Models the most common
   real "leak": nothing wrong with the engine, someone forgot to bound or
   clear a strongly-referenced cache.
3. **`weakmap-cycle`** — for each of N iterations, allocate a pair of
   objects that reference *each other* (`a.other = b; b.other = a`, a real
   cycle), store the pair as a `WeakMap` value keyed by a throwaway
   `holder` object, and keep the holders in an array so the pairs stay
   reachable. Then drop the holders array. **Required case**: proves a
   cycle behind a `WeakMap` boundary is collected as soon as the key is
   unreachable, no `.delete()` needed.
4. **`map-cycle-retained`** — identical cyclic pairs, but keyed into a
   plain `Map` that stays in scope. GC runs *while the map still holds
   them* first (nothing is reclaimed — direct contrast with #3), then the
   map is `.clear()`-ed and GC runs again (now it's reclaimed). Isolates
   the variable that actually matters: it was never the cycle, it was the
   container.

Each pattern samples `process.memoryUsage()` before allocation, at 25/50/75/100%
of the fill, at peak, immediately after dropping references (pre-GC), and
after a forced GC.

### Findings (`results/memory-latest.csv`, 200,000 objects/pattern, Node v26)

| phase | peak heapUsed (MB) | post-release/clear + GC heapUsed (MB) | reclaimed? |
|---|---|---|---|
| array-churn | 35.4 | 3.1 | yes |
| map-cache | 50.2 | 3.1 | yes (only after explicit `.clear()`) |
| weakmap-cycle | 92.5 | 3.1 | yes — despite the cycle |
| map-cycle-retained (GC'd while still referenced) | 76.2 | **72.7** | **no** |
| map-cycle-retained (after `.clear()` + GC) | — | 3.1 | yes |

Full per-sample table is in `results/memory-latest.csv`; run
`./scripts/run-memory.sh` to reproduce it.

**Interpretation:**

- `array-churn` and `map-cache` both fall back to baseline (~3 MB) once
  every reference is dropped and a full GC runs — a tracing collector
  reclaims unreachable memory completely; there is no special cost to
  "cleaning up" beyond making things unreachable.
- `weakmap-cycle` peaks *higher* than the others (92.5 MB vs ~35–50 MB)
  simply because it allocates twice as many objects per iteration (a pair,
  not a singleton) plus the holder object — not because cycles cost more
  to collect. It still returns to baseline: the cycle is irrelevant to a
  tracing GC, only reachability of the `holder` key matters.
- `map-cycle-retained` is the important negative control: **the exact same
  object shape, GC'd while the `Map` still references it, does not shrink**
  (76.2 → 72.7 MB, essentially unchanged — the small drop is other garbage
  from earlier phases, not this data). Only after `registry.clear()` does
  the next GC bring it back to baseline. This isolates the real leak
  mechanism in JS apps: a strongly-referencing container someone forgot to
  bound or clear, never the presence of a cycle.
- `heapTotal`/`rss` stay elevated after GC even when `heapUsed` returns to
  baseline (e.g. RSS sits around ~206 MB throughout the second half of the
  run even though `heapUsed` keeps dropping to ~3 MB). This is expected: V8
  reserves heap segments/pages rather than returning them to the OS on
  every collection. `heapUsed` — not RSS — is the number that tells you
  whether your objects were actually reclaimed.

### Hermes parity

`src/memory/hermes/probe.hermes.ts` is the same three patterns rewritten
with zero imports and no Node built-ins (`fs`/`process` don't exist for
Hermes running as a standalone script or in an RN JS thread), reading
`HermesInternal.getInstrumentedStats()` for heap numbers when available.
Compile it in isolation (it's excluded from the main `tsc` build):

```sh
npx tsc -p tsconfig.hermes.json
hermes dist-hermes/probe.hermes.js     # or paste into an RN Hermes debug context
```

**This was not executed against a real Hermes runtime in this environment**
— no `hermes`/`hermesc` binary was available here, only Node. It's provided
so the same allocate/release shapes are ready to run on-device or via the
Hermes CLI; expect the same qualitative sawtooth (grow → drop after
release), since Hermes is generational/tracing for the same reasons V8 is.
Treat the `results/*` numbers as V8-only.

---

## Part B — multithreading benchmark

### The task

Prime counting by trial division over `[0, RANGE_END)`, chunked into
fixed-size ranges (`CHUNK_SIZE`, default 2000). It's genuinely CPU-bound and
its cost is data-dependent per number, which is exactly why dynamic
chunking (below) matters more than a naive equal static split.

### Thread synchronization (`src/threads/worker.ts`, `benchmark.ts`)

Two `SharedArrayBuffer`s back the whole benchmark — real shared memory
across threads, not a copy handed to each worker:

- **`cursorBuffer`** (`Int32Array`, 1 slot) is a **work queue**. Every
  worker loops `Atomics.add(cursor, 0, CHUNK_SIZE)`, which atomically reads
  the current offset *and* advances it in one indivisible step, then claims
  `[offset, offset+CHUNK_SIZE)` as its own. No two workers can ever receive
  the same offset, and no chunk is skipped, regardless of how many workers
  are racing on it or how unevenly they progress — this is dynamic
  work-stealing instead of a static pre-split, which matters here because
  chunk cost varies with the numbers in it.
- **`resultBuffer`** (`Int32Array`, 2 slots) accumulates the answer two
  ways from the *same* `localCount` on every worker, to make the
  correctness point directly comparable in one run:
  - slot 0 via `Atomics.add(result, 0, localCount)` — a correct atomic
    read-modify-write.
  - slot 1 via plain `result[1] = result[1] + localCount` — a normal,
    non-atomic read-modify-write on the same shared memory.

`Atomics.add` is guaranteed indivisible with respect to other atomic ops on
the same address: two workers adding concurrently can never interleave and
lose an update. The plain-assignment slot has no such guarantee — a worker
can read slot 1, get preempted before writing back, and have another worker
also read-modify-write in between, silently dropping one worker's
contribution. Nothing throws or crashes; the total is just quietly wrong.

### Findings (`results/threads-latest.csv`, `RANGE_END=4,000,000`, `CHUNK_SIZE=2000`, Apple M5 / 10 logical cores)

Single-threaded baseline (no `worker_threads`, no `Atomics` at all):
**283,146 primes in 94.5 ms**.

| workers | elapsed (ms) | throughput (M/s) | speedup | atomicTotal | racyTotal | atomic correct | racy correct |
|---|---|---|---|---|---|---|---|
| 1 | 132.8 | 30.1 | 0.71x | 283146 | 283146 | yes | yes |
| 2 | 64.7 | 61.8 | 1.46x | 283146 | 283146 | yes | yes |
| 4 | 38.3 | 104.6 | 2.47x | 283146 | 283146 | yes | yes |
| 8 | 39.4 | 101.5 | 2.40x | 283146 | 283021 | yes | **no** |
| 10 | 39.6 | 101.0 | 2.39x | 283146 | 282999 | yes | **no** |

(Re-running shows the same shape run to run; exact ms/racy-drift jitter by
a few percent, reproduce with `./scripts/run-threads.sh`.)

**Interpretation:**

- **Correctness**: `atomicTotal` matches the single-threaded ground truth
  (283,146) at *every* worker count, every run. `racyTotal` matches only
  while contention is low (1–4 workers here) and starts silently
  undercounting once enough workers are genuinely racing on the same cache
  line (8–10 workers, off by 125–150 in these runs) — a direct,
  reproducible demonstration of why a non-atomic read-modify-write on
  shared memory across threads is a bug, not a style preference.
- **Speedup is real but sub-linear and non-monotonic**: 1 worker is
  *slower* than the plain single-threaded loop (0.71x) — that's pure
  `Worker` + isolate startup overhead with only ~4M/2000 = 2000 chunks of
  work to amortize it over. Speedup climbs to ~2.5x at 4 workers, then
  *flattens and slightly drops* by 8–10 workers rather than continuing
  toward 10x on a 10-core machine. Two things are visible in that
  flattening at once: Apple M5's 10 logical cores are a mix of
  performance/efficiency cores (not 10 uniform cores, so linear scaling
  past the performance-core count was never on the table), and the shared
  `cursorBuffer` slot is a single cache line every worker hammers with
  `Atomics.add` — more workers means more contention on that one address,
  which is the same mechanism that makes the racy counter start losing
  updates at exactly the same worker counts.
- **Chunk size is the knob that trades these off**: smaller chunks →
  better load balancing (primality cost is uneven) but more `Atomics.add`
  traffic on the shared cursor; larger chunks → less contention but worse
  balancing and coarser work-stealing granularity. 2000 was picked
  empirically as a reasonable middle point for this range size; use
  `HERMES_PROBE_CHUNK` to explore the tradeoff.

---

## Reproducibility notes

- Memory sampling always runs with `node --expose-gc` and explicitly
  forces two back-to-back `global.gc()` calls before every "post-gc"
  sample, specifically so numbers don't depend on V8's own lazy GC
  scheduling.
- Every run overwrites `results/*-latest.csv` and prints a plain-text table
  to stdout, so `diff`-ing two runs or scripting further analysis is a
  matter of running `./scripts/run-memory.sh` / `./scripts/run-threads.sh`
  again.
- `HERMES_PROBE_COUNT`, `HERMES_PROBE_RANGE`, `HERMES_PROBE_CHUNK`,
  `HERMES_PROBE_WORKERS` control scale without touching source.
