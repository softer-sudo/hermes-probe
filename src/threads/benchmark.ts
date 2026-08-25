import { Worker } from "worker_threads";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { countPrimesInRange } from "./task";
import { requirePositiveInt } from "../env";
import { RESULT_ATOMIC_INDEX, RESULT_RACY_INDEX, RESULT_BUFFER_BYTES } from "./layout";

const RANGE_END = requirePositiveInt("HERMES_PROBE_RANGE", process.env.HERMES_PROBE_RANGE, 4_000_000);
const CHUNK_SIZE = requirePositiveInt("HERMES_PROBE_CHUNK", process.env.HERMES_PROBE_CHUNK, 2_000);
const WORKER_COUNTS = (process.env.HERMES_PROBE_WORKERS ?? "1,2,4,8,10")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`error: HERMES_PROBE_WORKERS must be a comma-separated list of positive integers, got invalid entry ${JSON.stringify(s)}`);
      process.exit(1);
    }
    return n;
  });
if (WORKER_COUNTS.length === 0) {
  console.error("error: HERMES_PROBE_WORKERS must contain at least one positive integer");
  process.exit(1);
}

interface WorkerRunResult {
  workers: number;
  elapsedMs: number;
  throughputMops: number;
  speedup: number;
  atomicTotal: number;
  racyTotal: number;
  atomicCorrect: boolean;
  racyCorrect: boolean;
}

function now(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function runWithWorkers(n: number): Promise<{ elapsedMs: number; atomicTotal: number; racyTotal: number }> {
  const cursorBuffer = new SharedArrayBuffer(4);
  const resultBuffer = new SharedArrayBuffer(RESULT_BUFFER_BYTES);
  const cursor = new Int32Array(cursorBuffer);
  const result = new Int32Array(resultBuffer);
  Atomics.store(cursor, 0, 0);
  Atomics.store(result, RESULT_ATOMIC_INDEX, 0);
  Atomics.store(result, RESULT_RACY_INDEX, 0);

  const workerPath = path.join(__dirname, "worker.js");
  const start = now();

  const workers: Worker[] = [];
  const runs = Array.from(
    { length: n },
    () =>
      new Promise<void>((resolve, reject) => {
        const worker = new Worker(workerPath, {
          workerData: { cursorBuffer, resultBuffer, rangeEnd: RANGE_END, chunkSize: CHUNK_SIZE },
        });
        workers.push(worker);
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0) reject(new Error(`worker exited with code ${code}`));
          else resolve();
        });
      })
  );

  return Promise.all(runs)
    .then(() => ({
      elapsedMs: now() - start,
      atomicTotal: Atomics.load(result, RESULT_ATOMIC_INDEX),
      racyTotal: Atomics.load(result, RESULT_RACY_INDEX),
    }))
    .catch((err) => {
      // One worker erroring/exiting non-zero must not leave its siblings
      // running forever (they'd otherwise keep the process alive past the
      // point the failure was already reported).
      for (const w of workers) void w.terminate();
      throw err;
    });
}

function printTable(rows: WorkerRunResult[]): void {
  const headers = ["workers", "elapsed(ms)", "throughput(M/s)", "speedup", "atomicTotal", "racyTotal", "atomic OK", "racy OK"];
  const cells = rows.map((r) => [
    String(r.workers),
    r.elapsedMs.toFixed(1),
    r.throughputMops.toFixed(2),
    `${r.speedup.toFixed(2)}x`,
    String(r.atomicTotal),
    String(r.racyTotal),
    r.atomicCorrect ? "yes" : "NO",
    r.racyCorrect ? "yes" : "no",
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const printRow = (cols: string[]) => console.log(cols.map((c, i) => c.padEnd(widths[i])).join("  "));
  printRow(headers);
  printRow(widths.map((w) => "-".repeat(w)));
  for (const c of cells) printRow(c);
}

function writeCsv(rows: WorkerRunResult[], filePath: string): void {
  const header = "workers,elapsed_ms,throughput_mops,speedup,atomic_total,racy_total,atomic_correct,racy_correct";
  const lines = rows.map(
    (r) =>
      `${r.workers},${r.elapsedMs.toFixed(3)},${r.throughputMops.toFixed(4)},${r.speedup.toFixed(4)},${r.atomicTotal},${r.racyTotal},${r.atomicCorrect},${r.racyCorrect}`
  );
  fs.writeFileSync(filePath, [header, ...lines].join("\n") + "\n");
}

async function main(): Promise<void> {
  console.log("hermes-probe :: multithreading benchmark (worker_threads + SharedArrayBuffer/Atomics)");
  console.log(`range: [0, ${RANGE_END}) chunk size: ${CHUNK_SIZE} logical cpus: ${os.cpus().length}`);
  console.log("");

  const baselineStart = now();
  const baselineCount = countPrimesInRange(0, RANGE_END);
  const baselineMs = now() - baselineStart;
  console.log(`single-threaded baseline (no workers, no Atomics): ${baselineCount} primes in ${baselineMs.toFixed(1)} ms\n`);

  const rows: WorkerRunResult[] = [];
  for (const n of WORKER_COUNTS) {
    const { elapsedMs, atomicTotal, racyTotal } = await runWithWorkers(n);
    rows.push({
      workers: n,
      elapsedMs,
      throughputMops: RANGE_END / (elapsedMs / 1000) / 1e6,
      speedup: baselineMs / elapsedMs,
      atomicTotal,
      racyTotal,
      atomicCorrect: atomicTotal === baselineCount,
      racyCorrect: racyTotal === baselineCount,
    });
  }

  printTable(rows);

  const resultsDir = path.join(__dirname, "..", "..", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeCsv(rows, path.join(resultsDir, `threads-run-${stamp}.csv`));
  writeCsv(rows, path.join(resultsDir, "threads-latest.csv"));
  console.log(`\nwrote results/threads-run-${stamp}.csv (and threads-latest.csv)`);

  if (rows.some((r) => !r.atomicCorrect)) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
