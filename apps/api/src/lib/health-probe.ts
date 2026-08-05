import type { SystemConnected } from "@flow-gatekeeper/contracts";

/**
 * **008 `/ws` 探活方式的歷史產物**——009 起 `healthcheck.ts` 改走 `GET /healthz`（涵蓋
 * Redis／Mongo 連通深度，見 `specs/009-observability-baseline/contracts/health-endpoint.md
 * §7）。本檔與其既有測試**保留不移除**：純函式、無副作用，移除只會一併刪掉既有測試，
 * 收益為零。
 *
 * 判定一則 ws 原始訊息是否為 Gateway 的連線確認（`system/connected`）——008 健康探針的核心
 * 判準（FR-011、008 research D6、contracts §5）。
 *
 * `handleConnection` 在連線當下無條件送出 `system/connected`（不需 token、不受 WS_AUTH_SECRET
 * 影響），故收到它精確證明「HTTP server 在聽 **且** Gateway 已 attach」——正是 demo 所需的能力。
 *
 * 純函式、決定性、對畸形輸入不拋錯（探針收到任何非預期字串都應安全判否，而非讓行程崩潰）。
 * 型別依契約既有的 `SystemConnected`（憲章 III：不另寫平行定義）。
 */
export function isConnectedMessage(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // 非 JSON／畸形字串 → 不命中，不拋錯
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { type?: unknown }).type === ("system/connected" satisfies SystemConnected["type"])
  );
}
