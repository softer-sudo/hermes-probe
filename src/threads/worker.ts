import { workerData } from "worker_threads";
import { countPrimesInRange } from "./task";
import { RESULT_ATOMIC_INDEX, RESULT_RACY_INDEX } from "./layout";

interface ProbeWorkerData {
  cursorBuffer: SharedArrayBuffer;
  resultBuffer: SharedArrayBuffer;
  rangeEnd: number;
  chunkSize: number;
}

const { cursorBuffer, resultBuffer, rangeEnd, chunkSize } = workerData as ProbeWorkerData;

const cursor = new Int32Array(cursorBuffer);
const result = new Int32Array(resultBuffer);

for (;;) {
  const start = Atomics.add(cursor, 0, chunkSize);
  if (start >= rangeEnd) break;
  const end = Math.min(start + chunkSize, rangeEnd);
  const localCount = countPrimesInRange(start, end);

  // Correct atomic read-modify-write.
  Atomics.add(result, RESULT_ATOMIC_INDEX, localCount);

  // Deliberately non-atomic read-modify-write on the same shared memory,
  // kept exactly as-is: this is the intentional "racy" counter the README's
  // "Thread synchronization" section demonstrates losing updates under
  // contention. Do not change this to an atomic op.
  result[RESULT_RACY_INDEX] = result[RESULT_RACY_INDEX] + localCount;
}
