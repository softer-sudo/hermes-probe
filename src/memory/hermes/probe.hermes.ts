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

const out: (...args: unknown[]) => void =
  typeof print === "function" ? print : (console as unknown as { log: (...a: unknown[]) => void }).log;

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

const COUNT = 100000;

function arrayChurn(): void {
  sample("array-churn", "before-alloc");
  let arr: { id: number; values: number[] }[] = [];
  for (let i = 0; i < COUNT; i++) {
    arr.push({ id: i, values: [i, i * 2, i * 3, i * 5, i * 7, i * 11, i * 13, i * 17] });
  }
  sample("array-churn", "peak-before-release");
  arr = [];
  sample("array-churn", "after-release");
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
  sample("weakmap-cycle", "after-release");
}

function mapReferenceCycleRetained(): void {
  sample("map-cycle-retained", "before-alloc");
  const registry = new Map<number, { a: CycleNode; b: CycleNode }>();
  for (let i = 0; i < COUNT; i++) {
    registry.set(i, makeCycle(i));
  }
  sample("map-cycle-retained", "peak-still-referenced");
  registry.clear();
  sample("map-cycle-retained", "after-explicit-clear");
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
