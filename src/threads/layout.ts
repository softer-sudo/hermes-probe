/**
 * Shared memory layout for `resultBuffer`, used by both benchmark.ts (which
 * allocates it and reads the totals back) and worker.ts (which writes into it).
 *
 * The atomic counter and the deliberately-racy counter must NOT share a cache
 * line: every worker hits both on every chunk (`Atomics.add` on one, a plain
 * read-modify-write on the other), so packing them into adjacent Int32 slots
 * (as two slots of one 8-byte buffer) makes them false-share a line and adds
 * contention that has nothing to do with the `cursorBuffer` contention the
 * README's "Findings" section attributes the 8-10 worker flattening to. Each
 * slot gets its own 64-byte-aligned stride so that confound is removed.
 */
export const RESULT_ATOMIC_INDEX = 0;
export const RESULT_RACY_INDEX = 16; // 16 * 4 bytes = 64-byte cache-line stride
export const RESULT_BUFFER_BYTES = 128; // two 64-byte-aligned slots
