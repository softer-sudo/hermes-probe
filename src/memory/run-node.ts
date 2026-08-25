import * as fs from "fs";
import * as path from "path";
import { Sample, Sampler } from "./types";
import { forceGC } from "./gc";
import {
  arrayChurn,
  mapCacheLeakThenClear,
  weakMapReferenceCycle,
  mapReferenceCycleRetained,
} from "./patterns";
import { requirePositiveInt } from "../env";

const COUNT = requirePositiveInt("HERMES_PROBE_COUNT", process.env.HERMES_PROBE_COUNT, 200_000);
const t0 = Date.now();
const samples: Sample[] = [];

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

const sample: Sampler = (phase, label) => {
  const mem = process.memoryUsage();
  samples.push({
    t: Date.now() - t0,
    phase,
    label,
    heapUsedMB: mb(mem.heapUsed),
    heapTotalMB: mb(mem.heapTotal),
    rssMB: mb(mem.rss),
    externalMB: mb(mem.external),
  });
};

function printTable(rows: Sample[]): void {
  const headers = ["t(ms)", "phase", "label", "heapUsed(MB)", "heapTotal(MB)", "rss(MB)", "external(MB)"];
  const cells = rows.map((r) => [
    String(r.t),
    r.phase,
    r.label,
    r.heapUsedMB.toFixed(2),
    r.heapTotalMB.toFixed(2),
    r.rssMB.toFixed(2),
    r.externalMB.toFixed(2),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const printRow = (cols: string[]) =>
    console.log(cols.map((c, i) => c.padEnd(widths[i])).join("  "));
  printRow(headers);
  printRow(widths.map((w) => "-".repeat(w)));
  for (const c of cells) printRow(c);
}

function writeCsv(rows: Sample[], filePath: string): void {
  const header = "t_ms,phase,label,heap_used_mb,heap_total_mb,rss_mb,external_mb";
  const lines = rows.map(
    (r) => `${r.t},${r.phase},${r.label},${r.heapUsedMB},${r.heapTotalMB},${r.rssMB},${r.externalMB}`
  );
  fs.writeFileSync(filePath, [header, ...lines].join("\n") + "\n");
}

function main(): void {
  const gcAvailable = typeof (global as unknown as { gc?: () => void }).gc === "function";
  console.log(`hermes-probe :: memory/GC probe (V8 / Node ${process.version})`);
  console.log(`object count per pattern: ${COUNT}`);
  console.log(
    gcAvailable
      ? "global.gc() available -> post-gc samples reflect a forced full collection"
      : "WARNING: run with `node --expose-gc` for deterministic post-gc samples (see README)"
  );
  console.log("");

  sample("baseline", "start");
  arrayChurn(sample, COUNT);
  mapCacheLeakThenClear(sample, COUNT);
  weakMapReferenceCycle(sample, COUNT);
  mapReferenceCycleRetained(sample, COUNT);
  forceGC();
  sample("baseline", "end");

  printTable(samples);

  const resultsDir = path.join(__dirname, "..", "..", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeCsv(samples, path.join(resultsDir, `memory-run-${stamp}.csv`));
  writeCsv(samples, path.join(resultsDir, "memory-latest.csv"));
  console.log(`\nwrote results/memory-run-${stamp}.csv (and memory-latest.csv)`);
}

main();
