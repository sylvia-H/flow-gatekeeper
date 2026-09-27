/**
 * 故障注入旗標（007 US3；research D6、data-model E3）——可重現演練「致命 → 重啟 → 恢復」。
 *
 * 環境變數（運維層契約 contracts/supervision-runtime.md §2）：
 * - `WORKER_CHAOS`：`uncaught`｜`rejection`；未設定＝關閉。**預設 MUST 關閉、僅供演練**。
 * - `WORKER_CHAOS_AT`：`startup`（bootstrap 後約 2s 拋，供崩潰迴圈演練）｜
 *   `job`（下一筆 job 進入 active 時拋，供進行中工作重派演練）；預設 `startup`。
 * - `WORKER_CHAOS_ALLOW_IN_PRODUCTION`：`true` 才允許在 `NODE_ENV=production`（容器 image）武裝；
 *   預設 `false`（見 `parseChaosAllowInProduction`）。
 *
 * 非法值一律 warn 後**視為關閉**——零影響原則優先於 fail-fast：演練工具壞了，
 * 不該把正常啟動變成致命（含 `WORKER_CHAOS_AT` 非法：時點意圖不明時寧可不注入）。
 */

export type ChaosKind = "uncaught" | "rejection";
export type ChaosAt = "startup" | "job";

export interface ChaosConfig {
  kind: ChaosKind;
  at: ChaosAt;
}

export interface ChaosParseResult {
  /** null＝關閉（未設定、空值或非法值）。 */
  config: ChaosConfig | null;
  /** 非法值的警告訊息（由呼叫端記 log，保持本函式純粹）。 */
  warnings: string[];
}

const KINDS: readonly ChaosKind[] = ["uncaught", "rejection"];
const ATS: readonly ChaosAt[] = ["startup", "job"];

/** 純函式：解析 chaos 環境設定（vitest 標的；憲章測試門檻）。 */
export function parseChaosConfig(env: Record<string, string | undefined>): ChaosParseResult {
  const rawKind = env.WORKER_CHAOS?.trim();
  if (!rawKind) return { config: null, warnings: [] }; // 未設定／空值＝關閉、零影響

  if (!KINDS.includes(rawKind as ChaosKind)) {
    return {
      config: null,
      warnings: [`WORKER_CHAOS 非法值 "${rawKind}"（合法：uncaught|rejection），視為關閉`],
    };
  }

  const rawAt = env.WORKER_CHAOS_AT?.trim();
  if (rawAt && !ATS.includes(rawAt as ChaosAt)) {
    return {
      config: null,
      warnings: [`WORKER_CHAOS_AT 非法值 "${rawAt}"（合法：startup|job），注入時點不明，視為關閉`],
    };
  }

  return { config: { kind: rawKind as ChaosKind, at: (rawAt as ChaosAt) || "startup" }, warnings: [] };
}

/**
 * production 守衛的獨立開關 `WORKER_CHAOS_ALLOW_IN_PRODUCTION`（純函式）。
 *
 * 為什麼需要：worker image 內 `NODE_ENV=production`，守衛若只看 NODE_ENV，一鍵 demo 容器內的
 * 崩潰演練一律不生效。開關必須**明確**設成 `true` 才放行（大小寫不拘）——「遺留在 production
 * .env 的 WORKER_CHAOS 靜默造成崩潰迴圈」的防護仍是預設。非法值與 chaos 其他旗標同一原則：
 * warn 後視為 `false`（不放行），不升級為啟動失敗。
 */
export function parseChaosAllowInProduction(env: Record<string, string | undefined>): {
  allow: boolean;
  warnings: string[];
} {
  const raw = env.WORKER_CHAOS_ALLOW_IN_PRODUCTION?.trim().toLowerCase();
  if (!raw || raw === "false") return { allow: false, warnings: [] };
  if (raw === "true") return { allow: true, warnings: [] };
  return {
    allow: false,
    warnings: [
      `WORKER_CHAOS_ALLOW_IN_PRODUCTION 非法值 "${env.WORKER_CHAOS_ALLOW_IN_PRODUCTION}"（合法：true|false），視為 false`,
    ],
  };
}

/** 是否武裝 chaos：非 production 一律可；production 僅在明確開關放行時可。 */
export function shouldArmChaos(nodeEnv: string | undefined, allowInProduction: boolean): boolean {
  return nodeEnv !== "production" || allowInProduction;
}

/** startup 時點的延遲：讓 bootstrap 完整走完（連線、ready log）再注入。 */
const STARTUP_DELAY_MS = 2000;

/** 最小結構相依：只需要 BullMQ Worker 的 `once("active")`（可測、不綁死型別）。 */
export interface ActiveEventSource {
  once(event: "active", listener: () => void): unknown;
}

function throwChaos(kind: ChaosKind, at: ChaosAt): void {
  const err = new Error(`WORKER_CHAOS 故障注入（${kind}@${at}，僅供演練）`);
  if (kind === "rejection") {
    // 浮空 Promise.reject → 觸發真實 unhandledRejection 路徑（不經任何 try/catch）。
    void Promise.reject(err);
  } else {
    // 在 timer/setImmediate callback 內 throw → 真實 uncaughtException 路徑。
    throw err;
  }
}

/**
 * 武裝故障注入。`startup`：bootstrap 後約 2s 拋；`job`：下一筆 job 進入 active 時以
 * `setImmediate` 拋出——脫離 processor 的 try/catch 與 BullMQ 的 job 級錯誤處理，
 * 成為真正的 process 級致命錯誤（否則只會走 ai/error 重試路徑，演練不到 US2）。
 */
export function armChaos(
  config: ChaosConfig,
  worker: ActiveEventSource,
  warn: (msg: string) => void,
): void {
  warn(`WORKER_CHAOS 已武裝：${config.kind}@${config.at}（僅供演練，勿用於正常運行）`);
  if (config.at === "startup") {
    setTimeout(() => throwChaos(config.kind, config.at), STARTUP_DELAY_MS);
  } else {
    worker.once("active", () => setImmediate(() => throwChaos(config.kind, config.at)));
  }
}
