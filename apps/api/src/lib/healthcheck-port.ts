import { parseApiEnv } from "./env-schema.js";

/** 健康探針解析 port 的結果：成功帶 port；失敗帶可直接輸出的原因（不含祕密值）。 */
export type HealthcheckPortResult = { ok: true; port: number } | { ok: false; message: string };

/**
 * 以 api 本體同一份 env schema 解析探針要連的 port。env 不合法時 api 本身會拒絕啟動，探針同樣判
 * unhealthy——但必須把原因帶出來：只 `exit(1)` 不說明時，`docker inspect` 的 health log 只看得到
 * 「unhealthy」，查不出是設定錯而非服務掛掉。`parseApiEnv` 的訊息逐條列出變數與原因，且不回顯
 * `WS_AUTH_SECRET`／`REDIS_PASSWORD` 的值，可安全輸出到 stderr。
 */
export function resolveHealthcheckPort(env: Record<string, string | undefined>): HealthcheckPortResult {
  try {
    return { ok: true, port: parseApiEnv(env).API_PORT };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
