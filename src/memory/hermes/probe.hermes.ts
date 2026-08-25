/*
 * Standalone probe for the Hermes engine (e.g. `hermes probe.hermes.js`, or pasted
 * into a React Native debug context). Deliberately has zero imports/exports and no
 * Node built-ins: the Hermes CLI executes a flat script, not a CommonJS module, and
 * a device JS thread has neither `fs` nor `process`. Compile with tsconfig.hermes.json.
 *
 * Not executed as part of this repo's measured results (no `hermes` binary in this
 * environment) - see README "Hermes parity" section.
 */

interface HermesInstrumentedStats {
  [key: string]: number | string;
}

declare const HermesInternal:
  | {
      getInstrumentedStats?: () => HermesInstrumentedStats;
    }
  | undefined;

declare function print(...args: unknown[]): void;

// Only needed for the fallback below (running this file under Node/ts-node
// for local type-checking, not the real Hermes target which has `print` but
// no `console`) - declared minimally here instead of pulling in @types/node,
// which would defeat the point of tsconfig.hermes.json's `types: []`.
declare const console: { log: (...args: unknown[]) => void } | undefined;

const out: (...args: unknown[]) => void =
  typeof print === "function" ? print : typeof console !== "undefined" ? console.log : () => {};

// Mirrors src/memory/gc.ts's forceGC() for the Node/V8 probe: some Hermes
// hosts expose a global `gc()` for deterministic collection (analogous to
// Node's `--expose-gc`), some don't. Guarded the same way `HermesInternal`
// is above, so this degrades to a no-op instead of a ReferenceError when
// unavailable.
declare function gc(): void;

function forceGC(): boolean {
  if (typeof gc === "function") {
    gc();
    return true;
  }
  return false;
}

function statsAvailable(): boolean {
  return typeof HermesInternal !== "undefined" && typeof HermesInternal.getInstrumentedStats === "function";
}

function snapshot(): HermesInstrumentedStats | null {
  if (!statsAvailable()) return null;
  return (HermesInternal as { getInstrumentedStats: () => HermesInstrumentedStats }).getInstrumentedStats();
}

interface Row {
  t: number;
  phase: string;
  label: string;
  stats: HermesInstrumentedStats | null;
}

const t0 = Date.now();
const rows: Row[] = [];

function sample(phase: string, label: string): void {
  rows.push({ t: Date.now() - t0, phase, label, stats: snapshot() });
}

interface CycleNode {
  id: number;
  values: number[];
  other: CycleNode | null;
}

function makeCycle(i: number): { a: CycleNode; b: CycleNode } {
  const a: CycleNode = { id: i, values: [i, i + 1, i + 2, i + 3], other: null };
  const b: CycleNode = { id: -i, values: [i, i + 1, i + 2, i + 3], other: null };
  a.other = b;
  b.other = a;
  return { a, b };
}

// 100,000 rather than run-node.ts's 200,000: this file has no `process`, so
// it can't read HERMES_PROBE_COUNT (or any env var) to match that default -
// see the file header. Pass a different count by editing this constant.
const COUNT = 100000;

function arrayChurn(): void {
  sample("array-churn", "before-alloc");
  let arr: { id: number; values: number[] }[] = [];
  for (let i = 0; i < COUNT; i++) {
    arr.push({ id: i, values: [i, i * 2, i * 3, i * 5, i * 7, i * 11, i * 13, i * 17] });
  }
  sample("array-churn", "peak-before-release");
  arr = [];
  sample("array-churn", "after-release-pre-gc");
  forceGC();
  sample("array-churn", "after-release-post-gc");
}

function weakMapReferenceCycle(): void {
  sample("weakmap-cycle", "before-alloc");
  const registry = new WeakMap<object, { a: CycleNode; b: CycleNode }>();
  let holders: object[] = [];
  for (let i = 0; i < COUNT; i++) {
    const holder = {};
    registry.set(holder, makeCycle(i));
    holders.push(holder);
  }
  sample("weakmap-cycle", "peak-before-release");
  holders = [];
  sample("weakmap-cycle", "after-release-pre-gc");
  forceGC();
  sample("weakmap-cycle", "after-release-post-gc");
}

function mapReferenceCycleRetained(): void {
  sample("map-cycle-retained", "before-alloc");
  const registry = new Map<number, { a: CycleNode; b: CycleNode }>();
  for (let i = 0; i < COUNT; i++) {
    registry.set(i, makeCycle(i));
  }
  sample("map-cycle-retained", "peak-still-referenced");
  // Negative control (see patterns.ts): force a GC while the Map still
  // references everything, to show it does NOT reclaim retained cycles.
  // Without this, the pattern degenerates into a plain before/after-clear
  // timing probe and can't demonstrate that invariant at all.
  forceGC();
  sample("map-cycle-retained", "post-gc-while-retained");
  registry.clear();
  sample("map-cycle-retained", "after-explicit-clear-pre-gc");
  forceGC();
  sample("map-cycle-retained", "after-explicit-clear-post-gc");
}

sample("baseline", "start");
arrayChurn();
weakMapReferenceCycle();
mapReferenceCycleRetained();
sample("baseline", "end");

out(`hermes-probe :: memory/GC probe (Hermes) - object count per pattern: ${COUNT}`);
if (!statsAvailable()) {
  out("HermesInternal.getInstrumentedStats() unavailable in this JS context.");
  out("Run under the Hermes CLI/RN Hermes runtime with instrumentation enabled to get heap numbers;");
  out("this script still exercises the allocation patterns and prints phase timings below.");
}
for (const r of rows) {
  out(`${r.t}ms  ${r.phase}  ${r.label}  ${r.stats ? JSON.stringify(r.stats) : "(no stats)"}`);
}
