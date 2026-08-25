/**
 * Reads an optional environment variable as a positive integer, or fails loudly.
 *
 * Both probes accept scale knobs via env vars (HERMES_PROBE_COUNT, _RANGE,
 * _CHUNK, ...). Silently coercing a bad value (non-numeric -> NaN, "0", a
 * negative number) makes the probe run "successfully" while doing nothing
 * (every `for (i < count)` loop never executes) or hang forever (a chunk
 * cursor that can never reach a NaN/unreachable end) instead of telling the
 * user their input was invalid.
 */
export function requirePositiveInt(name: string, raw: string | undefined, defaultValue: number): number {
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`error: ${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return n;
}
