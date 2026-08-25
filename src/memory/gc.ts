export function forceGC(): boolean {
  const g = (global as unknown as { gc?: () => void }).gc;
  if (typeof g === "function") {
    g();
    g();
    return true;
  }
  return false;
}
