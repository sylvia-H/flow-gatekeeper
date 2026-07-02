/**
 * 指數退避 + 抖動（FR-013、SC-003）。
 * base = `min(1000 * 2^attempt, maxMs)`；再加 `0..30%` base 的抖動。
 * `rng` 可注入以利決定性測試（預設 Math.random）。
 */
export function nextBackoffDelay(
  attempt: number,
  maxMs = 30_000,
  rng: () => number = Math.random,
): number {
  const base = Math.min(1000 * 2 ** attempt, maxMs);
  const jitter = base * 0.3 * rng();
  return Math.round(base + jitter);
}
