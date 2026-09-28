/**
 * WebSocket upgrade 的 Origin 白名單（防 Cross-Site WebSocket Hijacking）。純函式，供 Gateway 使用。
 *
 * 白名單來自 `WS_ALLOWED_ORIGINS`（逗號分隔）。留空＝不檢查：demo 經 nginx 同源對外，
 * 瀏覽器帶的 Origin 就是自己，強制設定只會增加部署步驟而沒有實質保護。
 */

/** Origin 比對一律小寫、去尾端斜線（scheme/host 不分大小寫；手填設定常多一個 `/`）。 */
function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

/** 解析 `WS_ALLOWED_ORIGINS`；空字串、未設定或只有空白／逗號時回傳空陣列（＝不檢查）。 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map(normalizeOrigin).filter((o) => o.length > 0))];
}

/**
 * 是否放行此 upgrade。
 * - 白名單為空 → 一律放行；
 * - 沒有 Origin header → 放行：瀏覽器一定會帶 Origin，沒帶的是非瀏覽器 client（smoke 腳本、
 *   CLI），CSWSH 的攻擊面本來就只存在於瀏覽器；
 * - 有 Origin → 必須在白名單內。
 */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  if (origin === undefined || origin === "") return true;
  return allowed.includes(normalizeOrigin(origin));
}
