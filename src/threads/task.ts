export function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  if (n % 3 === 0) return n === 3;
  for (let i = 5; i * i <= n; i += 6) {
    if (n % i === 0 || n % (i + 2) === 0) return false;
  }
  return true;
}

export function countPrimesInRange(start: number, end: number): number {
  let count = 0;
  for (let i = start; i < end; i++) {
    if (isPrime(i)) count++;
  }
  return count;
}
