/**
 * 執行環境判準（api／worker／shared logging 共用）。
 *
 * 三端都以 `NODE_ENV` 決定 production 行為（api：metrics 出口自檢；worker：chaos 守衛；
 * logging：pretty 推導）。判準若各自實作（一端精確比對、一端正規化），同一個 `NODE_ENV=Production`
 * 或帶尾端空白的值就會讓同一部署一半行為是 prod、一半是 dev；故集中在此，正規化（trim + 小寫）
 * 後比較。`.env` 檔常見大小寫與尾端空白，正規化是刻意的寬鬆。
 */
export function isProductionEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv?.trim().toLowerCase() === "production";
}
