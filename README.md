# hermes-probe

A minimal TypeScript probe of two JS runtime internals:

- **Part A** — memory/GC: allocate/release objects in a few characteristic
  patterns (incl. a WeakMap/cycle case), sample heap usage, print a growth table.
- **Part B** — multithreading: a CPU-bound task single-threaded vs across
  `worker_threads`, synchronized with `SharedArrayBuffer`+`Atomics`.

Numbers below are real output from this machine (Node v26, Apple M5, 10 cores).

## Layout

```
src/memory/    types.ts, gc.ts, patterns.ts (4 patterns), run-node.ts (runner)
               hermes/probe.hermes.ts — standalone, import-free variant for Hermes
src/threads/   task.ts (prime counting), worker.ts, benchmark.ts (runner)
scripts/       run-memory.sh, run-threads.sh
results/       *-latest.csv — checked-in sample output of the last run
```

## Running it

```sh
npm install
./scripts/run-memory.sh          # Part A, Node/V8
./scripts/run-threads.sh         # Part B
```

Both take env vars for scale, each validated as a positive integer — an
invalid value (non-numeric, zero, negative, fractional) fails fast instead
of silently no-op'ing or hanging:

```sh
HERMES_PROBE_COUNT=500000 ./scripts/run-memory.sh
HERMES_PROBE_RANGE=8000000 HERMES_PROBE_CHUNK=4000 HERMES_PROBE_WORKERS=1,2,4,8 \
  ./scripts/run-threads.sh
```

Each run overwrites `results/*-latest.csv` and drops a timestamped
`*-run-*.csv` (gitignored scratch).

---

## Part A — memory/GC probe

Both V8 and Hermes use **tracing GC**: reachability is walked from roots, so
unreached cycles are still garbage — the "circular refs leak" folklore is a
refcounting-era myth that doesn't apply here. `WeakMap` uses **ephemeron**
semantics (a value lives only while its key is reachable elsewhere, no
`.delete()` needed); a plain `Map` holds everything until cleared. Both
engines are generational; `global.gc()` (`--expose-gc`) forces a
deterministic full collection instead of relying on lazy scheduling.

**Patterns** (`patterns.ts`): `array-churn` (baseline alloc/release),
`map-cache` (fill+`.clear()` a `Map` — the common real "leak"), `weakmap-cycle`
(a↔b cycle kept alive only via a WeakMap-keyed holder), `map-cycle-retained`
(same cycle, but keyed into a plain `Map` — GC'd once while referenced, once
after `.clear()`).

### Findings (200,000 objects/pattern)

| phase | peak heapUsed (MB) | post-release/clear + GC (MB) | reclaimed? |
|---|---|---|---|
| array-churn | 35.4 | 3.1 | yes |
| map-cache | 50.2 | 3.1 | yes (only after `.clear()`) |
| weakmap-cycle | 92.5 | 3.1 | yes — despite the cycle |
| map-cycle-retained (GC'd while referenced) | 76.2 | **72.7** | **no** |
| map-cycle-retained (after `.clear()`+GC) | — | 3.1 | yes |

The key negative control: the same shape, GC'd while still `Map`-referenced,
barely shrinks — only `.clear()` reaches baseline. It was never the cycle;
it's the container someone forgot to bound/clear. `heapTotal`/`rss` stay
elevated after GC even as `heapUsed` drops (V8 keeps pages reserved), so
`heapUsed` — not RSS — is what shows objects were actually reclaimed.

**Hermes parity**: `probe.hermes.ts` is the same three patterns (no
`map-cache`), zero imports/Node built-ins, reading
`HermesInternal.getInstrumentedStats()`. Compile separately
(`npx tsc -p tsconfig.hermes.json`, then `hermes dist-hermes/probe.hermes.js`).
**Not run against a real Hermes binary here** — treat `results/*` as V8-only.

---

## Part B — multithreading benchmark

Prime counting by trial division over `[0, RANGE_END)`, chunked
(`CHUNK_SIZE`, default 2000) — data-dependent cost, hence dynamic chunking.

Two `SharedArrayBuffer`s: **`cursorBuffer`** is a work queue (`Atomics.add`
atomically claims the next range, so nothing is skipped/double-claimed).
**`resultBuffer`** accumulates the same count two ways for direct
comparison: atomic `Atomics.add` (slot 0) vs plain non-atomic
`result[n] = result[n] + localCount` (slot 1, own cache line). The atomic
add can never lose an update; the plain one can — a worker reads, gets
preempted, another worker read-modify-writes in between, silently dropping
a contribution.

### Findings (`RANGE_END=4,000,000`, `CHUNK_SIZE=2000`, 10 logical cores)

Single-threaded baseline: **283,146 primes in 94.5 ms**.

| workers | elapsed (ms) | speedup | atomic correct | racy correct |
|---|---|---|---|---|
| 1 | 132.8 | 0.71x | yes | yes |
| 4 | 38.3 | 2.47x | yes | yes |
| 8 | 39.4 | 2.40x | yes | **no** |
| 10 | 39.6 | 2.39x | yes | **no** |

`atomicTotal` matches ground truth at every count; `racyTotal` silently
undercounts once enough workers genuinely race (8–10) — proof a non-atomic
read-modify-write on shared memory is a bug, not a style choice. Speedup is
sub-linear/non-monotonic: 1 worker is *slower* than none (startup overhead),
climbs to ~2.5x at 4, flattens by 8–10 — a mix of performance/efficiency
cores plus rising contention on the shared `cursorBuffer` cache line, the
same mechanism behind the racy drift. Chunk size trades load-balancing
against `Atomics.add` traffic on that cursor.
