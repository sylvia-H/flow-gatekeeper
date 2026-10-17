/**
 * 全站時間與耗時格式的單一來源（spec FR-022）。純函式、無相依，元件與 domain lib 一律經由這裡格式化。
 *
 * - 絕對時間：本地時區 24 小時制 `HH:mm:ss`。
 * - 相對時間：差 ≤ 2 秒（閉區間）→「剛剛」；< 60 秒 →「N 秒前」；其餘 →「N 分鐘前」。未來時間夾為 0（「剛剛」）。
 * - 耗時：先四捨五入到整數 ms；< 1000 ms →「N ms」，否則四捨五入到一位小數的秒「N.N s」（999.6 ms → `1.0 s`）。
 */

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 本地 24 小時制 `HH:mm:ss`。 */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const JUST_NOW_MS = 2_000;

/** 相對時間；`now` 由呼叫端提供（store 的 1 Hz tick），本函式不讀時鐘。 */
export function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff <= JUST_NOW_MS) return "剛剛";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)} 秒前`;
  return `${Math.floor(diff / 60_000)} 分鐘前`;
}

/** 耗時；以整數運算做一位小數的四捨五入，避開 `toFixed` 的二進位浮點誤差（例如 1.05 → 1.0）。 */
export function formatDuration(ms: number): string {
  const whole = Math.max(0, Math.round(ms));
  if (whole < 1_000) return `${whole} ms`;
  return `${(Math.round(whole / 100) / 10).toFixed(1)} s`;
}
