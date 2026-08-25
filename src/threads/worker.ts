import { parentPort, workerData } from "worker_threads";
import { countPrimesInRange } from "./task";

interface ProbeWorkerData {
  cursorBuffer: SharedArrayBuffer;
  resultBuffer: SharedArrayBuffer;
  rangeEnd: number;
  chunkSize: number;
}

const { cursorBuffer, resultBuffer, rangeEnd, chunkSize } = workerData as ProbeWorkerData;

const cursor = new Int32Array(cursorBuffer);
const result = new Int32Array(resultBuffer);

let chunksClaimed = 0;

for (;;) {
  const start = Atomics.add(cursor, 0, chunkSize);
  if (start >= rangeEnd) break;
  const end = Math.min(start + chunkSize, rangeEnd);
  const localCount = countPrimesInRange(start, end);
  chunksClaimed++;

  Atomics.add(result, 0, localCount);

  result[1] = result[1] + localCount;
}

parentPort?.postMessage({ chunksClaimed });
