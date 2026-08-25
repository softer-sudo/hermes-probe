import { Sampler } from "./types";
import { forceGC } from "./gc";

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

export function arrayChurn(sample: Sampler, count: number): void {
  const phase = "array-churn";
  sample(phase, "before-alloc");
  let arr: { id: number; values: number[] }[] = [];
  const checkpoint = Math.max(1, Math.floor(count / 4));
  for (let i = 0; i < count; i++) {
    arr.push({ id: i, values: [i, i * 2, i * 3, i * 5, i * 7, i * 11, i * 13, i * 17] });
    if ((i + 1) % checkpoint === 0) {
      sample(phase, `growing-${Math.round(((i + 1) / count) * 100)}pct`);
    }
  }
  sample(phase, "peak-before-release");
  arr = [];
  sample(phase, "after-release-pre-gc");
  forceGC();
  sample(phase, "after-release-post-gc");
}

export function mapCacheLeakThenClear(sample: Sampler, count: number): void {
  const phase = "map-cache";
  sample(phase, "before-alloc");
  const cache = new Map<string, { id: number; blob: string }>();
  const checkpoint = Math.max(1, Math.floor(count / 4));
  for (let i = 0; i < count; i++) {
    cache.set(`key-${i}`, { id: i, blob: "x".repeat(64) });
    if ((i + 1) % checkpoint === 0) {
      sample(phase, `growing-${Math.round(((i + 1) / count) * 100)}pct`);
    }
  }
  sample(phase, "peak-before-clear");
  cache.clear();
  sample(phase, "after-clear-pre-gc");
  forceGC();
  sample(phase, "after-clear-post-gc");
}

export function weakMapReferenceCycle(sample: Sampler, count: number): void {
  const phase = "weakmap-cycle";
  sample(phase, "before-alloc");
  const registry = new WeakMap<object, { a: CycleNode; b: CycleNode }>();
  let holders: object[] = [];
  const checkpoint = Math.max(1, Math.floor(count / 4));
  for (let i = 0; i < count; i++) {
    const holder = {};
    registry.set(holder, makeCycle(i));
    holders.push(holder);
    if ((i + 1) % checkpoint === 0) {
      sample(phase, `growing-${Math.round(((i + 1) / count) * 100)}pct`);
    }
  }
  sample(phase, "peak-before-release");
  holders = [];
  sample(phase, "after-release-pre-gc");
  forceGC();
  sample(phase, "after-release-post-gc");
}

export function mapReferenceCycleRetained(sample: Sampler, count: number): void {
  const phase = "map-cycle-retained";
  sample(phase, "before-alloc");
  const registry = new Map<number, { a: CycleNode; b: CycleNode }>();
  const checkpoint = Math.max(1, Math.floor(count / 4));
  for (let i = 0; i < count; i++) {
    registry.set(i, makeCycle(i));
    if ((i + 1) % checkpoint === 0) {
      sample(phase, `growing-${Math.round(((i + 1) / count) * 100)}pct`);
    }
  }
  sample(phase, "peak-still-referenced");
  forceGC();
  sample(phase, "post-gc-while-retained");
  registry.clear();
  sample(phase, "after-explicit-clear-pre-gc");
  forceGC();
  sample(phase, "after-explicit-clear-post-gc");
}
