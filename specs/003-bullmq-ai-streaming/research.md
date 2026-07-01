# Phase 0 Research: 診斷任務佇列、AI 串流診斷與 Redis 快取

本 feature 的技術取捨大多已由憲章（Principle IV/V/VI/VII）與實作指南 §8 固定，Phase 0 的工作是
**確認既定約束、把 spec 的三個 clarification 落到具體技術決策，並排除殘餘 unknown**。Technical
Context 中無 `NEEDS CLARIFICATION` 標記。

---

## D1. Job 佇列與速率限制：BullMQ + Redis

- **Decision**: 以 `@nestjs/bullmq` 在 api 端 `registerQueue(DIAGNOSIS_QUEUE='diagnosis')` 產 job；
  worker 端以 `new Worker(DIAGNOSIS_QUEUE, processor, { concurrency: 2, limiter: { max: AI_RPM, duration: 60_000 } })`
  消化。job options：`attempts: 3`、`backoff: { type:'exponential', delay:5000 }`、
  `removeOnComplete/removeOnFail` 保留上限（指南 §8.4/§8.5）。
- **Rationale**: limiter 放在 **worker 建立處**才能真正節流「實際處理」；api 只是入列，不該承擔
  rate limit（憲章 IV：API 不跑 long-running）。`AI_RPM`（預設 8）+ duration 60s 直接對應 SC-003
  「20 個 request/分鐘 ≤ AI_RPM」。
- **Alternatives considered**: 自寫 Redis list + 手動 rate limiter（重造輪子、無 retry/backoff）；
  在 api 端處理 job（違反 worker isolation）。皆否決。

## D2. 雙通道分流：QueueEvents（job 生命週期）vs Pub/Sub（token）

- **Decision**: job lifecycle（waiting/active/completed/failed/progress）由 api 端 `QueueEvents`
  監聽 → 組 `job/status` → `gateway.send(clientId, payload)`；AI token 由 worker 逐段
  `pub.publish('ai-stream:<jobId>', {type:'ai/token',...})`，api 端 `psubscribe('ai-stream:*')`
  轉發（指南 §8.11）。兩條流不混。
- **Rationale**: 憲章 IV 明訂雙通道分流——job 狀態與 token 混流會讓背壓與責任歸屬難以釐清。
  QueueEvents 是 BullMQ 對 job 狀態的一級來源，token 是應用層串流，本質不同。
- **Alternatives considered**: 把 job status 也塞進 `ai-stream:<jobId>`（違反分流原則）；worker
  直接 emit ws（違反 worker isolation，憲章 IV 明禁）。否決。

## D3. Redis 連線分離

- **Decision**: 以 `createRedisConnection()`（`ioredis`，`maxRetriesPerRequest: null`）工廠產出獨立
  連線：worker 端 `queueConnection`／`pub`／`cache` 三條；api 端 BullMQ 自管 + 一條專用
  `subscriber`（`psubscribe`）。subscriber MUST NOT 跑一般 command（指南 §8.6）。
- **Rationale**: 憲章 IV——共用連線（尤其 subscriber）會在 Pub/Sub 與一般 command 間互相卡住；
  BullMQ 也要求 blocking 連線 `maxRetriesPerRequest: null`。
- **Alternatives considered**: 單一共用 `ioredis`（會在 psubscribe 後無法跑 get/set，且 BullMQ 警告）。否決。

## D4. AiProvider interface 隔離 + Gemini adapter

- **Decision**: worker 主邏輯只依賴 `AiProvider.streamDiagnosis(prompt, onToken): Promise<string>`；
  `GeminiProvider`（`@google/generative-ai`，`generateContentStream`）為唯一 adapter，
  `const ai: AiProvider = new GeminiProvider(GEMINI_API_KEY, GEMINI_MODEL)`（預設 `gemini-2.5-flash`）。
  JSON 解析與 schema 驗證**不在 provider 內**（留在 worker）。
- **Rationale**: 憲章 V——換 provider（如未來 Claude）只加一支 adapter、改一行 new。provider 只負責
  「串流文字」，責任單一。
- **Alternatives considered**: worker 直接呼叫 SDK（provider 綁死、違反憲章 V）。否決。
- **接入前護欄**: 先做 `smoke-gemini.ts`（FR-017）確認 API key／模型／額度可用，再接 queue（指南 §8.2）。

## D5. Cache-aside 簽章與去重鎖

- **Decision**: `buildDiagnosisSignature({ machineId, state, topErrorCodes(sorted), promptVersion, model })`
  → `sha256` 取前 24 hex；`cacheKey=ai-cache:<sig>`、`lockKey=ai-lock:<sig>`（指南 §8.7）。流程：
  (1) cache hit → 回 `ai/done`（`cached:true`）直接 return；(2) miss → `SET lockKey 1 EX AI_DEDUPE_LOCK_SECONDS NX`
  取鎖；取不到者輪詢 cache（等他人算完共用）；(3) 取到鎖者打 LLM、寫 cache（`EX AI_CACHE_TTL_SECONDS`）、
  `finally` 釋鎖。
- **Rationale**: 簽章含**當前 state**才不會讓舊 critical 診斷命中現在 healthy 的機台（SC-002 案例 2）；
  含 promptVersion/model 讓改 prompt/換模型自動失效舊 cache。lock 保證同簽章並發只有一個真正打 LLM
  （SC-004），且 lock 有 TTL，持鎖者崩潰不會永久卡死（spec edge case）。簽章不含秒級 timestamp（否則永遠 miss）。
- **Alternatives considered**: 無 lock（並發洪水打爆 RPM）；簽章含 timestamp（永不命中）；簽章過粗
  （不同問題撞同一診斷）。皆否決。

## D6. Clarification 落地：cache-hit 只記輕量觸發稽核

- **Decision**: 完整 `DiagnosisResult` **只在 cache miss 實際產生時**寫 `diagnoses`（指南 §8.10 的
  `saveDiagnosis` 僅在 compute path）。**每次觸發（含 cache hit）**額外寫一筆 `diagnosisTriggers`
  輕量稽核 `{ machineId, jobId, requestedBy, cached, createdAt }`。
- **Rationale**: 呼應 spec Session 2026-07-01 Q1（只記輕量觸發稽核）——避免 `diagnoses` 因重複命中
  膨脹，同時保留「誰在何時觸發、是否命中」的可追溯性（憲章 VII）。worker 是唯一知道 hit/miss 的
  角色，故由 worker 寫入。
- **Alternatives considered**: 每次都寫完整 `diagnoses`（結果集合膨脹、重複）；完全不記命中（喪失
  觸發可追溯）。皆與 clarification 相左，否決。

## D7. Clarification 落地：AI streaming 30 秒應用層逾時

- **Decision**: `GeminiProvider.streamDiagnosis` 以 `AI_TIMEOUT_MS`（預設 30000）包一層逾時
  （`Promise.race` / `AbortController`）；逾時 throw → 由 worker 的 `failed` handler 轉 `ai/error`
  並依 `attempts`/backoff 重試。新增 `.env.example` 的 `AI_TIMEOUT_MS`。
- **Rationale**: 呼應 spec Q2（30 秒）與 FR-020——避免 provider 無回應時發起連線無限等待；30s 與
  SC-001 單次診斷時限一致。放在 provider adapter 內，主邏輯不需感知逾時細節。
- **Alternatives considered**: 不設應用層逾時（依 SDK 預設，可能長掛）；用 BullMQ job timeout（無法
  區分「串流慢」與「卡死」、且不利逐 token 串流）。否決。

## D8. Clarification 落地：POST /diagnoses 開發階段免授權

- **Decision**: `JobsController` 的 `POST /diagnoses` **不加授權守衛**；WS 訂閱維持 `WS_AUTH_SECRET`。
  README/quickstart 註明「REST 入口開發階段開放，正式環境認證待後續」。
- **Rationale**: 呼應 spec Q3（不需授權）與 FR-021、指南 §8.4 的 demo 用法；授權範圍僅涵蓋即時通道。
- **Alternatives considered**: REST 也套共享密鑰（前端需多帶憑證、超出本 feature 範圍）；自訂 API key
  機制（範圍膨脹）。否決。

## D9. 任務 → 連線綁定（記憶體 Map，重連失效）

- **Decision**: `AiStreamRelayService` 與 job-status relay 共用一份 `jobId → { clientId, machineId }`
  記憶體 Map；`JobsService` 建 job 時 `bindJobToClient(jobId, socketId, machineId)`；終態
  （`ai/done`/`ai/error` 或 completed/failed）後刪除綁定，避免 Map 無限成長。
- **Rationale**: 指南 §8.4/§8.11 記載的 side-project demo 取捨；client 重連 `clientId` 會換、舊綁定
  失效（spec 已列已知限制）。純後端 smoke 時 `socketId` 可填任意字串，job 仍跑完並寫 Mongo/cache。
- **Alternatives considered**: 綁定寫 Redis（`ai-job-client:<jobId>` 短 TTL）以支援重連續傳——正式
  做法，但超出本 feature demo 範圍，列為未來改進。

## D10. 契約擴充：jobs.ts（先入契約）

- **Decision**: 新增 `packages/contracts/src/jobs.ts` 匯出 `DIAGNOSIS_QUEUE` 常數與 `DiagnosisJobPayload`
  型別，`index.ts` re-export；`ai/token`、`ai/done`、`ai/error`、`job/status` 沿用既有 `events.ts`。
  `DiagnosisJobPayload` 屬 api↔worker 的傳輸型別，依型別來源分層 MAY 用 TS 定義（憲章 III）。
- **Rationale**: 憲章 II/III contract-first——api 與 worker 都要 import 同一份 `DIAGNOSIS_QUEUE` 與
  payload 型別，MUST NOT 各寫平行定義。`asyncapi.yaml` 描述 WS 通道，ai/*、job/status 已在其中，
  本 feature 對 asyncapi 無新增（job payload 非 WS 訊息）。
- **Alternatives considered**: 在 api/worker 各自 hardcode queue name 與 payload（違反單一來源）。否決。
