import { z } from "zod";

/**
 * worker 環境變數的單一來源（Zod，bootstrap 最前面 parse，失敗 fail-fast）。
 *
 * 為什麼要 preprocess 空字串：`.env` 常見 `AI_DEDUPE_LOCK_SECONDS=` 這種「留空」寫法，
 * 舊寫法 `Number(process.env.X ?? d)` 的 `??` 對空字串不生效 → 0 → `SET EX 0` 回錯、
 * 所有 job 失敗，且啟動時完全沒有徵兆。這裡一律把空字串視為「未設定」走預設值，
 * 真正不合法的值（負數、非整數、打錯字）則在啟動當下 exit 1，交給監督者語意呈現。
 * `GEMINI_API_KEY` 刻意永遠可選（見 parseWorkerEnv 的 warning 與 GeminiProvider 的缺金鑰處理）。
 *
 * 不涵蓋的變數與理由：`LOG_LEVEL`／`LOG_PRETTY`／`METRICS_LOG_LEVEL`／`METRICS_INTERVAL_MS`
 * 由 `@flow-gatekeeper/shared/logging` 解析，契約是「不合法回退預設並 warn」（009 已落地、
 * 與 api 共用）；`WORKER_CHAOS*` 由 `lib/chaos.ts` 解析，同樣是 warn 後視為關閉。
 * 這兩類刻意不升級為啟動失敗，以免 worker 與 api 對同一個變數有兩種語意。
 */

const emptyToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const stringWithDefault = (d: string) => z.preprocess(emptyToUndefined, z.string().default(d));
const positiveInt = (d: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(d));
/** 與 api 的 `port()` 同一規則：同一個 REDIS_PORT 不該 api 拒絕啟動、worker 卻照跑到連線才失敗。 */
const port = (d: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().max(65_535).default(d));

/** Redis 連線子集——healthcheck 探針也用它，不必連 AI 設定一起驗。 */
export const RedisEnvSchema = z.object({
  REDIS_HOST: stringWithDefault("127.0.0.1"),
  REDIS_PORT: port(6379),
  REDIS_PASSWORD: optionalString,
  /** cache／pub 一般指令的逾時；斷線時命令必須在這個時間內 reject，processor 才走得到錯誤路徑。 */
  REDIS_COMMAND_TIMEOUT_MS: positiveInt(5000),
  /**
   * 本實例的識別，組成 `worker:heartbeat:<id>`／`metrics:worker:<id>`（見 `lib/redis-keys.ts`）。
   * 放在 Redis 子集而非完整 schema：healthcheck 探針只 parse 這個子集，卻必須推導出與主行程
   * 相同的 id 才讀得到自己的心跳。留空 → 退回 hostname（容器內即 container id）。
   * 限制字元集：id 會直接拼進 key，含空白或 glob 字元（`*`、`?`、`[`）會讓 api 的 SCAN MATCH
   * 與人工排查都變得難以預期。
   */
  WORKER_INSTANCE_ID: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/, "只允許英數字與 . _ -")
      .optional(),
  ),
});

export const WorkerEnvSchema = RedisEnvSchema.extend({
  NODE_ENV: optionalString,
  MONGO_URL: stringWithDefault("mongodb://127.0.0.1:27017/flow-gatekeeper"),
  MONGO_DB: stringWithDefault("flow-gatekeeper"),
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: stringWithDefault("gemini-2.5-flash"),
  AI_TIMEOUT_MS: positiveInt(30_000),
  AI_DEDUPE_LOCK_SECONDS: positiveInt(45),
  AI_CACHE_TTL_SECONDS: positiveInt(600),
  /** 每分鐘「實際 LLM 呼叫」上限（取鎖且 cache 仍未命中後才計數，見 processor）。 */
  AI_RPM: positiveInt(8),
  WORKER_CONCURRENCY: positiveInt(2),
}).superRefine((env, ctx) => {
  // 鎖必須活得比一次 LLM 呼叫久：否則持鎖者還在串流時鎖已過期，等待者搶到鎖再打一次 LLM，
  // 去重直接失效。compare-and-del 只能保證「不刪別人的鎖」，擋不住這種重複呼叫。
  if (env.AI_DEDUPE_LOCK_SECONDS * 1000 < env.AI_TIMEOUT_MS) {
    ctx.addIssue({
      code: "custom",
      path: ["AI_DEDUPE_LOCK_SECONDS"],
      message: `AI_DEDUPE_LOCK_SECONDS（${env.AI_DEDUPE_LOCK_SECONDS}s）× 1000 必須 ≥ AI_TIMEOUT_MS（${env.AI_TIMEOUT_MS}ms）`,
    });
  }
});

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;
export type RedisEnv = z.infer<typeof RedisEnvSchema>;

export type WorkerEnvParseResult =
  | { ok: true; env: WorkerEnv; warnings: string[] }
  | { ok: false; error: string };

/** 純函式：parse 並把錯誤整理成一行可讀訊息（呼叫端決定 exit）。 */
export function parseWorkerEnv(raw: Record<string, string | undefined>): WorkerEnvParseResult {
  const parsed = WorkerEnvSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: formatIssues(parsed.error) };
  const warnings: string[] = [];
  if (!parsed.data.GEMINI_API_KEY) {
    // 任何環境都允許留空：沒有 Gemini 帳號的評估者仍能看到遙測與背壓兩個賣點。缺金鑰不會
    // 拖到重試用盡——provider 會丟不可重試錯誤，每筆診斷立即以友善的金鑰訊息失敗。
    warnings.push("GEMINI_API_KEY 未設定：每筆 AI 診斷將立即以 provider_error 失敗（不重試）");
  }
  return { ok: true, env: parsed.data, warnings };
}

/** healthcheck 探針用：只驗 Redis 子集。 */
export function parseRedisEnv(raw: Record<string, string | undefined>): RedisEnv {
  return RedisEnvSchema.parse(raw);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
