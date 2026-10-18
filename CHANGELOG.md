# Changelog

本檔記錄 flow-gatekeeper 對使用者／部署者可見的變更，格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，
產品版本遵循 [Semantic Versioning](https://semver.org/lang/zh-TW/)。開發過程的逐 commit 細節見 `git log`；
1.0.0 之後各維護分支的現況摘要見 `docs/Flow-Gatekeeper-SDD-完整實作指南.md` §15.6。

## 版本策略

本專案有**兩條彼此獨立**的版本號：

1. **產品版本**（`X.Y.Z`；git tag **不帶 `v` 前綴**，例 `1.1.0`）：**release 時**三者 MUST 一致——git tag ＝ 六份 `package.json` 的 `version`（root、`apps/api`、`apps/worker`、
   `apps/web`、`packages/contracts`、`packages/shared`）＝ 本檔頂端的版本條目；release 流程（`CLAUDE.md`「`main` 的 release 流程」）第 1 步核對。
   開發期 `package.json` 可先升到預定版本，`## [Unreleased]` 於 release 時改為 `## [X.Y.Z] - YYYY-MM-DD`。
2. **契約版本**：`asyncapi.yaml` 的 `info.version`，描述即時通道與 `POST /diagnoses` 的 wire 契約，**不跟產品版本走**。
   契約的任何加嚴（runtime 接受範圍變窄）、新增欄位、新增或改變消費端義務，都 MUST 升版——向後相容者升 minor，不相容者升 major；
   純措辭修正可升 patch。各版內容見下方「asyncapi 契約版本」小節，README 與指南中的 `info.version` 字串由
   `packages/contracts/src/docs-contract-version.test.ts` 自動比對。

**歷史說明**（不改寫既有 commit 歷史，只在此釐清）：

- 第一版的 tag 原名 `v1.0.0`，於 2026-09-28（1.1.0 發布時）**更名為 `1.0.0`**（指向同一 commit `3e94ac2`），GitHub Release 與 demo 影片下載連結一併改指 `1.0.0`；自此產品 tag 一律不帶 `v` 前綴。

- 1.0.0（2026-08-05）發布時，`asyncapi.yaml` 的 `info.version` 仍是起草時的 `0.1.0`；之後的第一輪審查修復（`cffb306`）一次把它
  改成 `1.1.0`，中間**沒有** 1.0.0，當時是把契約版本對齊「產品 1.0.0 之後的第一個變更」，語意不清。自 1.1.0 起兩條版本各自獨立演進。
- 1.0.0 時五份套件 `package.json`（apps ×3、packages ×2）的 `version` 一直停在 `0.1.0`，root `package.json` 則沒有 `version` 欄位，
  與 tag 沒有單一來源（第二輪審查 DOC-D14）；自 1.1.0 起五份套件由 `0.1.0` 對齊為 `1.1.0`、root 新增 `version`，六份與 tag 對齊。

## [2.1.0] - 2026-10-18

次版號升級：修掉 2.0.0 已公開的 P1（設了 `REDIS_PASSWORD` 而 Redis 認證失敗時，密碼經 BullMQ `console.error` 明文進 api stderr）與第三輪審查 Batch E；因下方「相容性注意」有對外可見的行為變更、契約升 asyncapi **1.3.0**，依 1.1.0 前例升 minor（使用者 2026-10-18 裁決 2.1.0，原規劃為 2.0.1）。demo 影片未重錄，README 下載連結仍指向 2.0.0 release 的資產。

第三輪審查（`docs/20260927-research-review03.md`）§6 Batch E 的 quick-fix，維護分支 `fix/20261018-review03-quickfix`（自 `develop` `45b1460`）；
現況摘要見指南 §15.6「第三輪審查 quick-fix」，未修與新增 backlog 見 ADR-002 §6.5.1 的 review03 列。括號內為報告的 finding ID。

### 相容性注意（升級前必讀）

- **壞 JSON 的 400 回應改變**（API-7／API-17）：body 由 Nest 預設的 `{"message":"<JSON 解析錯誤原文>","error":"Bad Request","statusCode":400}` 改為 `{"statusCode":400,"message":"Invalid JSON body"}`——message 固定英文、不再回顯本文片段，且**少了 `error` 欄位**；依 message 文字或 `error` 欄位判斷的外部 client 需改。契約不符的 400（`issues[]`）與 controller／service 回的 404／409／415／503 不變；body-parser 自己產生的其他 4xx 也改為固定的 HTTP reason phrase——charset／encoding 不支援的 415 由原文（如 `unsupported charset "X"`）改為 `Unsupported Media Type`，`request.aborted`、`request.size.invalid` 等 400 改為 `Bad Request`。
- **body 上限 100 kb → 16 kb**（API-7）：`POST /diagnoses` 正常請求不到 300 bytes；超過回 `413 {"statusCode":413,"message":"Payload too large"}`（原為 body-parser 原文 `request entity too large`）。
- **回應不再帶 `X-Powered-By: Express`**（API-7）。
- **Redis 指令物件的日誌形狀改變**（CT-13）：共用 logger 的遮蔽值一直是小寫 `[redacted]`。舊的 `REDACT_PATHS` 只有一層萬用字元，因此：頂層 `command` 與一層鍵下的命令（如 `{error:{command}}`）以前輸出 `"args":"[redacted]"`；**兩層以上**（如 `ctx.error.command`）與陣列內的命令物件以前是**明文**輸出 `args`——這正是 CT-13 修掉的外洩。現在 log 物件（`formatters.log`）與 child bindings（含 `setBindings` 與其子代）都在 redact 之前就全深度剝除：`command` 物件一律只剩 `{"command":{"name":…}}`、`args` 鍵整個消失，`command` 是陣列（如 `["auth", <密碼>]`）時只留命令名；正常寫法下已不會出現 `[redacted]`，只剩繞過上述兩道剝除、由比它們更淺的 `REDACT_PATHS` 防線攔下時才可能出現。以 `[redacted]` 字樣做 grep 或告警的規則會漏抓，請改比對 `command.name` 或以缺少 `args` 判斷。另外，放在非 `err` 鍵下的原生 Error 以前輸出 `{}`，現在輸出 type／message／stack。已知限制：`command` 若是**字串**（如 `"auth <pw>"`）會原樣輸出——字串無從判斷哪段是參數；ioredis／BullMQ 的命令都是 `{ name, args }` 物件，不受影響。**建議檢查升級前的日誌是否含明文 Redis 密碼**（`AUTH` 指令的 `args`），有則輪替密碼並清理日誌。
- **日誌等級與形狀**（API-7／API-17、API-11、WK-19）：依舊訊息比對的告警需改用新的比對方式——
  (a) body-parser 的 4xx：**壞 JSON 以前不記錄**（Nest 先把它轉成 `BadRequestException`，`BaseExceptionFilter` 不記錄 HttpException），現在新增一則節流的 warn；**413、415 等非 HttpException 以前每則都記 error**（context `ExceptionsHandler`，msg 為 `JSON.stringify(err)`，帶 413 的 `expected`／`length`／`limit`／`type` 等欄位），現在改為節流的 warn。兩者現在的形狀相同：依 `狀態碼:type` 節流（30 秒至多一則、附被壓掉的則數 `suppressed`），context `HttpExceptionFilter`，msg 固定為 `http request rejected`，欄位 `statusCode`、`method`、`path`、`errorType`（body-parser 的 `type`，如 `entity.parse.failed`），不帶本文；
  (b) api 的 Nest logger 收到 Error 時，msg 由 `JSON.stringify(err)`（通常只剩 `{}`）改為 `err.message`，並多出 `err` 鍵（type／message／stack）；
  (c) worker 的 `no_context` 終態由 `error` 等級的 `job failed (final)`（帶 `err` 與 stack）改為 `warn` 等級的 `job failed (final, no_context)`，帶 `code: "no_context"`、不帶 stack；其他最終失敗維持 `error` 的 `job failed (final)`；
  (d) HTTP 路由未預期的例外（500）：以前 context 為 `ExceptionsHandler`、msg 為 `"{}"`、沒有 stack；現在 context 為 `HttpExceptionFilter`、msg `unhandled request error`，帶 `err`（含 stack，剝掉 `body`）、`statusCode`、`method`、`path`。以 `context=ExceptionsHandler` 告警的規則會失效。
- **Buffer 欄位的日誌輸出改變**（CT-13 後續，`5a6c2be`）：log 物件裡的 Buffer 以前（頂層欄位）輸出 `"[unable to serialize, circular reference is too complex to analyze]"`，現在先經 `toJSON()` 再剝除，輸出正常的 `{"type":"Buffer","data":[…]}`；巢狀的 Buffer 以前就正常，形狀不變。
- **WS 入站限速**（API-13）：每連線 token bucket 穩態 20 則／秒、容量 40；超速的訊息不解析即丟棄並各計一次違規，與畸形訊息、錯誤 token 合計 10 次即以 `1008` 關閉。內建 web 穩態遠低於 1 則／秒、不受影響；以更高頻率送 `ping`／`machine/subscribe` 的自寫 client 或壓測腳本需降頻。
- **client 送的協定層 ping frame 不再自動回 pong**（API-13，使用者裁決 13）：Gateway 的 `WebSocketServer` 設 `autoPong: false`——協定層 ping 原本繞過入站 token bucket、違規計數與背壓自動回應。瀏覽器不會送協定層 ping，內建 web 不受影響；以協定層 ping 判活的自寫 client 需改用應用層 `ping` 訊息。伺服器探活方向（server 送協定層 ping、client 回 pong）不變。應用層 `pong` 在送出緩衝超過高水位時照回，放大量只靠入站 token bucket 限制。
- **關閉時的重複訊號**（API-12／WK-21，使用者裁決 11）：api 與 worker 收到第一次訊號後，1 秒內（< 1000 ms）再收到**同名**訊號會忽略並記 info（POSIX dev 的 watch 工具會把一次 Ctrl+C 送成兩次 SIGINT）；第 1000 ms 起的同名訊號、或任何不同名的訊號立即 `exit(0)`，exit 至多一次。
- **未授權連線子上限新公式**（API-14）：`max(1, min(MAX_WS_CONNECTIONS − 1, max(10, floor(20% × MAX_WS_CONNECTIONS))))`；只影響 `MAX_WS_CONNECTIONS ≤ 10` 且有設 `WS_AUTH_SECRET` 的部署（例如上限 5 時子上限由 10 變 4），預設 500 不變（仍為 100）。
- **自寫 WS client 的串流重置規則**（契約 1.3.0，AR-S8）：同一 `attempt` 內收到未遞增的 `seq`（`seq <= 上一個 seq`）即須視為新一次執行並清空累積文字；只認 `seq` 0 的實作在新執行的 seq 0 遺失時會把兩次執行的文字接在一起。
- **調高 `AI_TIMEOUT_MS` 時 worker `stop_grace_period` MUST 設為 `AI_TIMEOUT_MS`＋15 秒**（WK-21）：worker 行程內關閉總時限＝`AI_TIMEOUT_MS`＋10 秒，compose grace 要比它多 5 秒才不會被 SIGKILL；預設 30 s／45s 不需調整。
- **第三輪審查仍未修的 P2（本版帶著發布，使用者 2026-10-18 裁決）**：以下未在 2.1.0 修復，也都存在於 2.0.0（2.1.0 未使其變糟）；實測證據與修法見 `docs/20260927-research-review03.md`，括號內為 finding ID 與 roadmap 歸屬：
  - **Redis 停頓超過 30 秒時同一診斷會跑兩次**（AR-4，012-lite）：WS 會先後收到兩則 `ai/done`（內建畫面只採用第一則，自寫 client 要能處理重複）、觸發紀錄多一筆、快取命中統計重複；快取尚未寫成功時會再打一次 LLM，並用掉唯一一次 stalled 額度。
  - **worker 被強制終止後約 92 秒無事件**（AR-S7，012-lite）：BullMQ lock／stalled 參數為預設 30 s／30 s／1，45 秒 watchdog 會先把任務判失敗，重派後的結果需按重試才看得到。
  - **LLM 供應商故障時同簽章請求不去重**（WK-13，012-lite）：多人同時對同一機台同一狀態按診斷，每個請求各自重打 LLM（請求數 × 3 次嘗試），全部計費並消耗 `AI_RPM`；最後一個等待者最長要等 N × `AI_TIMEOUT_MS`。
  - **MongoDB 寫入診斷失敗時每次重試都重打 LLM**（WK-4 補強，012-lite；AR-A12 已修）：3 次嘗試全部計費、不送具體錯誤碼——前端只收到 api 補送的 `ai/error`（`worker_failed`），畫面顯示 Mongo 原始錯誤訊息（短訊息）或通用句「診斷失敗，請重試。」，訊息含逾時或連線字樣時會被誤報為「AI 診斷逾時」或「無法連線 AI 服務」；LLM 結果已寫快取後 trigger 才失敗而重試時，結果會被誤標「快取」。
  - **完成語意仍只靠 Pub/Sub 的 `ai/done`**（AR-5 根治部分，012-lite）：Pub/Sub 斷線時畫面 2～3 秒內顯示「結果未送達，請重試」而非結果；失敗終態沒有綁定寬限，`failed` 先到時前端收到籠統的 `ai/error`（`worker_failed`）、看不到 worker 送的具體失敗原因（使用者 2026-10-18 裁決接受）。
  - **CI 不自動觸發**（DOC-18／TQ-19／INF-14，待決策）：`ci.yml` 只保留手動觸發，push／PR 不會跑 CI（只在 Linux／Node 22 才出現的回歸要等人手動跑才發現，2.1.0 的 ThemeToggle 即一例）；nightly mutation 不論 `develop` 有無變更每日照跑。
  - **測試與契約閘門缺口**（CT-14、CT-15、TQ-18、WEB-24，Batch F／G）：asyncapi channels 寫錯、契約變更未升版、Gateway 關閉邏輯或 App 層重連接線被改壞時，測試都不會失敗；不影響目前執行行為。
  - **文件與流程類**（報告 §3.9，不影響執行行為）：
    - **版號不保證可直接升級**（DOC-15）：本檔宣稱依 SemVer，但尚未宣告「公開介面」、也未定義何謂相容；能否直接升級請以各版「相容性注意」為準，不要只看版號。
    - **backlog 不是完整清單**（DOC-17／WK-18）：ADR-002 §6.5.1 尚未移入第一輪報告 §3.1 a／c／d／f 等殘留項，C.9 #12／#13 的內容已遺失但未標記；查未修項時要同時看前兩輪報告。
    - **後續 feature 藍圖未寫進指南**（DOC-16）：012-lite／010-lite 的範圍只在第三輪報告 §5.4，起草時須回報告原文。
    - **變更紀錄有兩份**（DOC-20）：指南 §15.6 與本檔重複記錄維護分支，改一處要同步另一處，否則會不一致。
    - **merge hash 的回填規則未寫進 CLAUDE.md**（DOC-13）、**SDD 收尾清單未定**（DOC-21）：文件表格的 hash 回填與 feature 收尾的回補步驟目前靠人記得。

### Security

- **P1：api 端 BullMQ producer `Queue` 掛上節流的 `error` listener**（API-1）：設了 `REDIS_PASSWORD` 而 Redis 認證失敗時，密碼不再經 BullMQ 的 `console.error` 明文寫進 stderr（2.0.0 相容性注意所列的未修項）。
- **日誌全深度遮蔽 Redis 指令參數**（CT-13）：共用 logger 以 `formatters.log` 對整個 log 物件任意深度剝除 `command.args`（含 `err` 以外的鍵、陣列、class instance），不再只處理第一層 `err`；`command` 只留 `name`、陣列形狀只留命令名（`args` 鍵移除，正常寫法下不再輸出 `[redacted]`；兩層以上與陣列內的命令以前是明文，見相容性注意）；child bindings（含 `setBindings` 與子代）也在交給 pino 前同樣剝除（`5a6c2be`），Error 自我參照與有 `toJSON` 的物件同樣處理。
- **api Nest logger 的 Error 不再整包 `JSON.stringify`**（API-11）：Error 導到 `err` 鍵、msg 取 `err.message`，body-parser 錯誤夾帶的原始請求本文（`body`）不進日誌，`ReplyError` 的 `args` 經 serializer 剝除。
- **HTTP 錯誤不回顯輸入、不記本文**（API-7／API-17）：全域 `HttpExceptionFilter` 讓 body-parser 的 4xx 回固定英文 message、記 warn 並依狀態碼與類型節流（原本壞 JSON 不記錄、413／415 等每則 `logger.error` 且帶錯誤欄位，可被洗版）；未預期例外與 500 回 `Internal server error`，其他 5xx 的 http-errors 回該狀態碼的標準 reason phrase（如 503 `Service Unavailable`）；error 日誌保留原 message 與 stack（剝掉 `body`）。

### Fixed

- **`ai/done`／`ai/error` 早於 BullMQ 終態送出**（AR-5／WK-14）：worker 的終態事件（含 `no_context`）改為 await publish 後才結束 job，發布失敗只記 warn、不改 job 結果；`ai/token` 維持 fire-and-forget。
- **`completed` 後綁定保留 10 秒**（AR-5）：api relay 送出 `job/status: completed` 後延後刪綁定，走另一條 Redis 連線、稍晚抵達的 `ai/done` 仍送得到原連線；寬限內同 jobId 重送回 409「jobId 已使用過，請以新的 jobId 重新發起診斷」（job 仍在進行中時才回同一結果）；`failed` 不加寬限。
- **快取命中先落地後宣告**（AR-A12）：cache 命中路徑改為寫 trigger → `updateProgress(100)` → `ai/done`，與 LLM 路徑同序。
- **web 結果未送達收尾**（AR-6）：收到 `job/status: completed` 後 2 秒（單調時鐘 `performance.now()`，不受系統時鐘調整影響；每秒檢查，實際 2–3 秒）仍無 `ai/done` 即轉失敗，文案「診斷已在後端完成，但結果未送達畫面，請重試」、沿用重試鈕；只有這種失敗允許同 jobId 遲到的 `ai/done` 救回完成——上限是後端完成後約 10 秒內（relay 綁定寬限）且中間沒有重連；串流標題為「原始串流」（不加「（中斷前）」，後端已完成、串流完整）。原本要等 45 秒 watchdog。
- **Pub/Sub 訂閱中斷有日誌**（AR-6）：ai-stream subscriber 加掛 `close`／`reconnecting`，與 `error` 共用節流器，整段斷線只記一則 warn、恢復由既有 ready 記錄。
- **串流重播判定**（AR-S8）：web 以同一輪 `seq <= lastSeq` 判定新一次執行並清空串流文字；原以 `seq === 0` 判定，Pub/Sub 弄丟新執行的 seq 0 時會把兩次執行的文字接在一起。
- **api 關閉不再卡到 SIGKILL**（API-12）：stopProducer＋flush＋`app.close()` 總時限 12 秒，兩支 relay 的 Redis 連線關閉各限 3 秒（逾時 best-effort `disconnect()`）；逾時記 warn 後 `exit(0)`；關閉中再收到訊號立即 `exit(0)`（原本第二次訊號被吞掉），但第一次訊號後 1 秒內的同名訊號視為重送、忽略（使用者裁決 11）。
- **worker 關閉總時限與重入保護**（WK-21）：總時限 `AI_TIMEOUT_MS`＋10 秒（預設 40 秒），逾時記 warn 後 `exit(0)`；第二次訊號立即 `exit(0)`，1 秒內的同名訊號視為重送、忽略（使用者裁決 11）；Gemini SDK 明確設 `retryOptions.attempts: 1`，重試只交給 BullMQ。
- **`no_context` 終態記 warn**（WK-19）：業務上預期的空脈絡失敗不再以 error 帶 stack 記錄；trigger 照常補寫。
- **未授權連線不能單獨佔滿名額**（API-14）：`MAX_WS_CONNECTIONS ≤ 10` 時子上限原本等於或大於全域上限。
- **web 連上即送第一次 ping**（WEB-16）：原本第一次 ping 要等滿一個 15 秒間隔，連上後最長約 20 秒才偵測得到斷線。
- **web 不再觸發 CSP 違規回報**（WEB-13）：zod 4 預設以 `new Function` 探測 JIT，被 `script-src 'self'` 擋下；web 新增 `src/zod-config.ts`（`z.config({ jitless: true })`）作為 `main.ts` 第一個 import。
- **production CSS 不再含只在測試出現的 class**（WEB-15／TQ-23）：tailwind content 排除 `*.test.ts` 並以設定檔位置解析，postcss 以絕對路徑指向 tailwind 設定（不隨 cwd 漂移）。

### Changed

- **測試門檻提高**（TQ-20）：`pnpm test:coverage` 全域門檻 lines 60／branches 50 → **89／85**（合併門第 2 輪修正後於 HEAD 隔離實測 lines 92.33、branches 88.40 減 3、取整數往下；137 個測試檔 1988 支），另以 glob 對十個核心檔設逐檔下限（例如 `processor.ts` 95／84、`monitoring.gateway.ts` 96／89、`job-status-relay.service.ts` 95／78、`useHighFrequencyWs.ts` 94／70，全表與實測見 `vitest.config.ts`）；coverage reporter 加 `json-summary`。
- **coverage／mutation 輸出目錄可覆寫**（TQ-15）：`COVERAGE_DIR` 覆寫 coverage 輸出目錄（vitest 每次執行前會整個清空該目錄，必須用專屬目錄）；Stryker 報告目錄以 `MUTATION_REPORT_DIR` 覆寫（sandbox 本來就每次獨立建立，不需覆寫）。未設時路徑不變（CI 照舊上傳 `coverage/lcov.info`）。
- **web 直接依賴 `zod`**（WEB-13）：`apps/web/package.json` 新增 `zod ^4.6.5`（與 contracts 同版，lockfile 未新增套件）。
- **web 串流效能（部分修復）**（WEB-17）：`lastActivityAt` 改 plain Map（不再每個 token 觸發 reactive 追蹤），StreamingPanel 捲到底改為每幀至多一次，且只有捲到比程式上次捲動的位置更上方才算使用者上捲、回到底部即恢復跟隨（合併門第 2 輪修正 rAF 合併後跟隨被自身 scroll 事件關閉的回歸）。`jobs` 仍逐 token 寫入 reactive、partial-json 每則 token 重新解析，依使用者裁決 12（2026-10-18）接受、留在 backlog：Gemini 每秒約 10–20 則 token、代價小，改成每幀合併會動到 reducer 主路徑與它和 2 s 救回、`ai/done` 的順序（backlog 見 ADR-002 §6.5.1）。

### Internal

- 三支 `main.test` 改為檔頂 import，避免並行負載下冷載入逾時（TQ-14）；processor liveness 斷言改精確次數、不再對空陣列恆真（TQ-16）；補非最終嘗試 `ai_timeout` 與一般 Error 的重試語意測試（TQ-17）。
- Gateway 註解與實作對齊（孤兒 JSDoc、背壓略過含 `ai/token`、慢讀者回收時序、pong 與入站速率；API-15）。
- `ThemeToggle.test.ts` 在 `afterEach` 清掉主題偏好（`fg.theme`）：2.1.0 發版前首次以 GitHub Actions（ubuntu、Node 22）跑 CI 時，前一支測試寫入的深色偏好洩漏到下一支而失敗；本機 Node 26 的實驗性 `localStorage` 遮蔽 happy-dom 的實作、寫入無效，所以一直沒被發現（013 起即存在，非本批引入）。該次 CI 因這一支失敗而紅燈，但覆蓋率照常量得 lines 92.35％／branches 88.4％（Linux），與 Windows 隔離實測一致；修正後於打 tag 前在 `develop` 重跑 CI。

### 契約

- **契約 1.3.0**（向後相容的 minor，使用者 2026-10-18 裁決）：`asyncapi.yaml` `info.version` 1.2.0 → **1.3.0**。Zod schema 與訊息結構沒有改動，變的是 wire 行為與描述：
  WS 入站限速與 1008 違規關閉、client 送的協定層 ping frame 不回應、同一 `attempt` 內 `seq` 未遞增即視為新執行；`POST /diagnoses` body 上限 16 kb、新增 413、壞 JSON 400 改為固定形狀。明細見下方「asyncapi 契約版本」1.3.0。
- `packages/contracts/src/ai-stream.ts` 的 `seq` 註解同步改為與 AR-S8 一致。

## [2.0.0] - 2026-10-17

主版號升級：web 監控台整體換皮、介面文案改為繁體中文、1.0.0 的 demo 影片不再代表現況（使用者 2026-10-17 裁決）。WS／HTTP 契約與 api 行為向後相容（`asyncapi.yaml` 的 `info.version` 維持 1.2.0）；
worker 預設模型與輸出上限的變更見下方不相容變更。demo 影片 `docs/demo/flow-gatekeeper-demo.mp4` 同時為 2.0.0 GitHub Release 的資產（README 下載連結指向它）。本版包含：

- Feature 013（`013-ui-redesign`，`specs/013-ui-redesign/`）：web 監控台全面改版。013 只動前端呈現，**後端、契約與部署方式皆不變**；
  視覺方向為「實驗室玻璃與蝕刻刻度」，視覺真實來源由 `apps/web/design/design-spec.md` 改為 `apps/web/PRODUCT.md` 與 `apps/web/DESIGN.md`。
- `docs/20260927-research-review03`（merge `3ad0e9b`，2026-10-15）：第三輪審查報告；其發現的缺陷本版**未修**，見下方相容性注意。
- 維護分支 `fix/20261017-pause-toggle-label`：修正 013 開發期間改成固定「暫停」的做法，維持按下後換字（1.1.0 起即如此），本版文字為中文「恢復」、拿掉 `aria-pressed`。
- 維護分支 `upgrade/20261017-gemini-3.5-flash-lite`：worker 的預設 LLM 模型改為 `gemini-3.5-flash-lite`（契約不變）。
- 維護分支 `docs/20261018-demo-video`：README demo 影片以新介面重錄，新增錄影劇本 `apps/web/scripts/record-demo.cjs`。

### 不相容變更

- **介面文案全面改為繁體中文**：依 1.1.0 英文標籤（`Diagnose`、`Pause`／`Resume`、`Connected`、`Cached`、`Retry`、`Fleet monitor`、連線橫幅等）寫的外部截圖說明、操作手冊或 UI 自動化腳本需改用中文標籤；machine id、job id、技術單位（含 px）、`Mock`／`AI`／`WS`、佇列名 `diagnosis`、產品名 flow-gatekeeper 與 AI 回覆內容維持原文。
- **側欄機台清單（含英文分組標題 `Prep`／`Forming & Baking`／`Fulfilment`）移除**：機台與分組改由主區的三 stage 拓樸承載，stage 標題只有中文（前處理／成型烘烤／包裝分揀）；側欄只留品牌列、機群健康、異常摘要列與主題切換。依側欄清單點選機台、或依英文分組名定位的說明與腳本需改。
- **AI 診斷面板的斷點與互動模型改變**：視窗寬 ≥ 1366px 為寬 348px 的推擠式右側面板，< 1366px 一律改為底部 bottom-sheet；所有寬度預設收合，選取機台才自動展開（手動收合後不再自動展開）。1.1.0 在 ≥ 768px 為寬 400px、預設展開、選台即重新展開的可收合右欄，< 768px 為帶遮罩的 bottom-sheet（70–85vh）；2.0.0 在 768–1365px 也改為 bottom-sheet，細節見下方 Changed。
- **背壓比值的口徑改變**：主要顯示的比值由「自頁面載入起的累計值」改為「最近 60 秒視窗」，與 1.1.0 TopBar 徽章的數字不可直接比較；累計值改放 tooltip。
- **1.0.0 demo 影片作廢**：舊介面影片只留在 1.0.0 Release，README 下載連結改指 2.0.0 Release（1.1.0 未重錄）。
- **預設模型改為 `gemini-3.5-flash-lite`、`AI_MAX_OUTPUT_TOKENS` 預設 2048 → 4096**（worker）：只影響 `GEMINI_MODEL`／`AI_MAX_OUTPUT_TOKENS` 留空的部署；
  `apps/worker/.env` 明寫 `GEMINI_MODEL=gemini-2.5-flash` 者維持舊模型，要換請改值或清空。3.x flash 系列以 `thinkingLevel: MEDIUM` 思考，
  thinking token 計入輸出上限：`AI_MAX_OUTPUT_TOKENS` 明寫 2048 的部署換到新模型時，worker 啟動會 warn，建議改為 ≥ 4096（或清空走預設）。
  模型名進快取簽章，換模型後舊快取自然不再命中（第一次診斷會重新呼叫 LLM）。

### 相容性注意（升級前必讀）

- **第三輪審查發現的缺陷在 2.0.0 仍未修**（P1 與 Batch E 已於 2.1.0 修復，見上方 `[2.1.0]`）：含一項 P1——api 端 BullMQ producer `Queue` 未掛 `error` listener，設了 `REDIS_PASSWORD` 而 Redis 認證失敗時，密碼會經 BullMQ 的 `console.error` 明文進 stderr（pino 路徑已遮蔽）。
  部署時請留意 api 的 stderr 收集範圍；細節與其他未修項見 `docs/20260927-research-review03.md` 與 README「已宣告的取捨」。
- **新增 localStorage key**：`fg.theme`（`"light"`｜`"dark"`，主題選擇）與 `fg.copilot-panel`（`{"manuallyCollapsed":boolean}`，AI 診斷面板的手動收合偏好）；
  讀寫失敗（私密視窗、封鎖儲存）時回到預設、不顯示錯誤。既有的 `flow-gatekeeper:sidebar-width`、`flow-gatekeeper:event-strip-height` 沿用、不改名，升級後原有尺寸保留。
- **主題預設為淺色、不跟隨作業系統**：首次載入一律淺色，深色需手動切換一次，之後依 `fg.theme` 記憶。
- **新 devDependency `playwright-core`**（`apps/web`，`~1.64.1`）：只供截圖劇本 `apps/web/scripts/screenshots.cjs` 與 demo 錄影劇本 `apps/web/scripts/record-demo.cjs` 使用，不進 production bundle；
  劇本需本機 Playwright Chromium（`PLAYWRIGHT_CHROMIUM` 指定路徑，未設時自動尋找 `ms-playwright` 目錄），見 README「快速開始」。一般開發、`pnpm check`、`pnpm build` 與 demo 容器不需要瀏覽器。
- **字型改為 Source Sans 3、Noto Sans TC、JetBrains Mono**（仍經 Google Fonts、載入失敗退回系統字型）；nginx CSP 不需調整。
- Node／pnpm 版本要求不變（`engines.node >=22.12`、pnpm 10.34.5）。

### Added

- **深淺雙主題**：淺色為預設，以單一控制項切換（桌機在側欄、手機在工具列），切換同一幀完成、無閃爍與版面位移，選擇記在本機。
- **背壓 strip**：主區頂端常駐顯示每秒訊息數 → 每秒批次數 → 合併比，三個讀數同取最近 60 秒視窗（相除對得上），標籤「合併比 · 訊息 ÷ 批次」並常駐一行白話說明（例如「每幀平均合併 N 則訊息」）；
  比值刻度 0–60（每 10 格標數字），0 到目前比值為實心液柱、液位線標目前比值，超過 60 釘在右端標「>60」，刻度上另有 1:1 錨點與近 60 秒最高水位短線；
  另附最近 60 秒的單秒合併比走勢線（一條，y 軸自 0、離群值釘頂）與 60 秒內丟棄數（「丟棄 N 則」，有丟棄才以警示色顯示）；暫停期間與恢復後 2 筆樣本排除於合併比、平均、最高水位與走勢線（走勢線斷線，丟棄數照計）；
  斷線、重新連線、暫停時以狀態 pill「已斷線／重新連線中／已暫停」標示；手機仍保留比值、每秒訊息數與丟棄數。
- **暫停橫幅**：暫停時主區上方顯示「已暫停畫面更新 · 暫停於 HH:mm:ss」橫幅並附「恢復」鈕（1.1.0 沒有橫幅）；工具列的暫停鈕照舊按下後換字，改為中文「恢復」與墨色底，不再用 `aria-pressed`（狀態改由按鈕名稱表達）。
- **診斷串流漸進骨架**：診斷進行中，摘要、嚴重度、建議動作、可能原因、證據會邊串流邊填入與完成態相同的結果骨架，未解析出的欄位以佔位呈現；原始串流文字可展開查看。
- **快取耗時對比**：完成時以一行顯示「完成 HH:mm:ss · 耗時」；命中快取時以大字顯示本次耗時並列該台上一次非快取耗時，下方以同一刻度的兩條耗時橫條對照（只有一筆時不畫），結果整塊直接呈現。
- **「再次診斷」**：完成態在 meta 列下方提供「再次診斷」次要鈕，不必回工具列即可再診斷同一台、走到快取對比。
- **異常標記記憶**：機台由警告／嚴重回到正常後，卡片保留「最近異常」標記與相對時間 30 秒（進行中「嚴重 · 進入 N 秒前」、回復後「曾嚴重 · N 秒前回復」）；
  卡片上的標記不可點擊（避免誤觸選台區域就不可逆地確認），確認入口有三個——側欄異常摘要列每列的「確認」鈕（Check 圖示）、鍵盤聚焦卡片按 `x`、手機異常清單——三處讀寫同一份狀態；
  確認後改為劃線的「已確認」狀態並保留到回復滿 30 秒；30 秒內再次異常或警告升為嚴重時重置為未確認。
- **側欄異常摘要列**：列出目前異常與最近 30 秒內曾異常的機台（狀態燈、名稱、相對時間），點列選取該台、每列有「確認」鈕，全部正常時顯示「目前沒有異常」。
- **卡片診斷狀態 chip**：每張卡片顯示該台的診斷狀態（診斷中與進度、「AI：嚴重度」、「AI：嚴重度 · 快取」、「AI 失敗」），以「AI：」起頭與狀態徽章區隔，4px 方角、無圖示。
- **事件流合併與「回復正常」事件**：同機台、同嚴重度的事件自該列首筆起算 60 秒固定窗內合併為一列，列上顯示起訖時間與次數（`HH:mm:ss–HH:mm:ss · ×N`），滿 60 秒另起新列；機台回到正常時新增中性色的「回復正常」事件；每一列可點擊選取對應機台。
- **快捷鍵說明鈕**：工具列提供開啟快捷鍵說明層的按鈕，與 `?` 共用同一個開關。
- **鍵盤快捷鍵**：`/` 聚焦搜尋（搜尋結果只剩一台時 Enter 直接選取）、方向鍵依視覺位置在卡片間移動焦點、Enter 選取聚焦卡片、`d` 對選取機台觸發診斷、
  `x` 確認聚焦卡片的異常標記、Escape 每次只關最上層一項（說明層 → 搜尋覆蓋 → 手機異常清單 → AI 診斷面板 → 取消選取）、`?` 開關快捷鍵說明層；輸入欄內不觸發。
- **拖曳把手可用鍵盤調整**：側欄寬度與事件流高度的把手可 Tab 聚焦，方向鍵以 16px 步距調整（範圍不變：側欄 200–420px、事件流 100–360px）。
- **AI 診斷面板偏好與 peek 條**：以面板收合鈕手動收合後，之後選取機台不再自動展開，「觸發診斷」或點展開把手才展開並清除此偏好（Escape 收合不算）；
  收合時若仍有選取機台，退為 32px 的 peek 條（機台名稱與診斷狀態），點一下即展開。
- **手機機群健康摘要條**：手機寬度時主區頂端常駐一條比例條與四個計數，點擊展開為異常清單覆蓋層（不推擠拓樸）。

### Changed

- **視覺世界**：改為「實驗室玻璃與蝕刻刻度」——桌面格線底、半透明玻璃面板、蝕刻刻度與等寬數值；所有顏色改為語意 token，兩套主題同名、只換值。
- **三 stage 產線拓樸取代機台網格**：主畫面依序分為「前處理 → 成型烘烤 → 包裝分揀」三欄，相鄰欄之間的流向連線粗細與流動速度隨下游產能變化（減少動態效果時只變粗細）；
  搜尋過濾後空欄保留並顯示「此階段無符合的機台」；窄版改為上下堆疊、段間以短箭頭連接。
- **卡片**：數值改 24px 等寬並附小刻度（超標換警示色），警告卡片加全邊框、嚴重卡片加底色與邊框，停滯改為虛線邊框＋「停滯」徽章（不再整卡降透明）；
  機台 id 與更新時間移到標頭第二列（相對時間 ≥ 3 秒才顯示）；選取態改為卡片外側 2px outline，保留原本的狀態邊框與底色；狀態、hover、選取與嚴重脈動皆不改卡片尺寸。
- **診斷結果**：區段順序改為摘要與嚴重度 → 建議動作 → 可能原因 → 證據；證據預設只展開前 2 筆，來源與內容相同者合併為一列並顯示 `×N`；
  完成態改以頂部嚴重度色條與一行 meta 呈現，不再用滿版進度條；失敗態以分類說明錯誤、提供重試，並展開原始串流保留中斷前的推理。
- **AI 診斷面板在所有寬度預設收合**，無手動收合偏好時選取機台才自動展開；視窗寬 ≥ 1366px 為寬 348px 的推擠式側面板，< 1366px 一律改用底部抽屜（bottom-sheet，附抓取把手）；
  抽屜在未診斷的閒置態只佔單列（約 51px）、非 modal（無遮罩、焦點留在卡片），主區與側欄依抽屜高度留白不被遮住，進行中／完成／失敗時才轉為 modal。
  面板標頭 chip 在未診斷時顯示「未診斷」、完成時顯示中性的「已完成」。
- **工具列**：分為導航、播放控制、系統狀態、主要動作四組；可用寬度 640–819px 時只留圖示、< 640px 時搜尋收成圖示鈕並以覆蓋式輸入框展開；手機的主題切換移入系統狀態組。
- **全部 UI 文案改為繁體中文**（stage 標題只有中文）；時間格式統一為 24 小時制 `HH:mm:ss`、相對時間「剛剛／N 秒前／N 分鐘前」、耗時 `N ms`／`N.N s`。
- **最小功能性字級 12px**：徽章、單位、計數、時間戳等小字不再小於 12px，兩套主題下文字對比皆 ≥ 4.5:1。
- **README 截圖**：「功能逐項展示」的截圖隨本版以新介面重拍（含深色主題與拓樸），圖說與 demo 劇本改用中文術語。
- **README demo 影片重錄**（`docs/20261018-demo-video`）：以新介面與新模型重錄 23 秒 demo（1440×900 H.264，`docs/demo/`），下載連結改指 `releases/download/2.0.0/`；
  1.0.0 的舊介面影片作廢、僅留在 1.0.0 release。新增錄影劇本 `apps/web/scripts/record-demo.cjs`（CDP 逐格擷取＋ffmpeg，需含 libx264 的 ffmpeg，見 README「截圖劇本」段末）。
- **AI 模型**（worker）：預設 `GEMINI_MODEL` 由 `gemini-2.5-flash` 改為 `gemini-3.5-flash-lite`。3.x 以後的 `flash`／`flash-lite` 不接受
  `thinkingBudget: 0`（400），改送 `thinkingConfig.thinkingLevel: MEDIUM`；實測真實診斷 prompt 的 thinking token 為 0～約 1150（模型動態決定），
  首 token 0.6～4.2 秒、全程 1.4～4.6 秒（思考時較長；003 SC-001 的 5 秒首 token 目標仍達成但餘裕有限）。`AI_TEMPERATURE` 維持 0.2：Google 建議 Gemini 3 系列用 1.0，但實測 0.2／1.0 皆無截斷、0.2 結果較一致。3.x 的 pro 等其他變體維持不送 thinking 設定。3.x `flash`／`flash-lite` 配 `AI_MAX_OUTPUT_TOKENS` 低於 4096 時 worker 啟動會 warn
  （2.5 pro 等不能關 thinking 的模型門檻維持 8192）；`GEMINI_MODEL` 為不帶版本號的 `*-latest` 別名時啟動 warn（判不出 thinking 系列）。
  worker `LLM stream finished` log 的 `usage` 另記 `thoughtsTokens`（thinking token，與只算回覆的 `outputTokens` 分開）。

### Removed

- **側欄機台清單**：機台改由拓樸三欄承載，側欄只留品牌列、機群健康、異常摘要列與主題切換。
- **TopBar 背壓徽章**：由主區頂端的背壓 strip 取代。
- **`apps/web/design/refs/`** 截圖參考目錄自 repo 移除；`apps/web/design/design-spec.md` 保留全文、檔頭標註已退役，視覺以 `apps/web/PRODUCT.md`、`apps/web/DESIGN.md` 為準。

### 契約

- **無變更**：`asyncapi.yaml` 的 `info.version` 維持 1.2.0；12 則 WS 訊息與 `POST /diagnoses` 的請求與回應皆未修改，api 無行為變更，
  worker 只換預設模型、thinking 設定與 `AI_MAX_OUTPUT_TOKENS` 預設（見上方 Changed「AI 模型」）。新呈現（背壓 strip、拓樸連線、異常標記、診斷耗時）全部由既有訊息在前端衍生。

## [1.1.0] - 2026-09-28

2026-09 三輪全面審查後的加固版：修復兩輪審查報告的 P0～P2、升級技術棧、補齊測試基礎建設。tag `1.1.0`，對應 `develop` 併入 `main` 的 merge commit。彙整 1.0.0 之後的四條維護分支（皆已於 2026-09-27～28 併入 `develop`）：

- `fix/20260927-research-review`（merge `a8ef62a`）：第一輪全面審查（`docs/20260927-research-review.md`）的修復。
- `upgrade/20260927-tech-stack`（merge `6be71c6`）：技術棧升級。
- `fix/20260927-research-review02`（merge `898ccfc`）：第二輪審查（`docs/20260927-research-review02.md`）Batch A／B 修復。
- `fix/20260927-review02-batch-cd`（merge `4c43d18`）：第二輪審查 Batch C（文件與 release 準備）與 Batch D（測試基礎建設），含最終兩段式 code-review 的 9 個修正 commit。

第三輪審查報告（`docs/20260927-research-review03.md`，審 `4c43d18`）在 1.1.0 之後另以 `docs/` 分支併入；其發現的缺陷（含一項 P1：api 端 BullMQ producer `Queue` 未掛 `error` listener，Redis 認證失敗時密碼經 `console.error` 明文進 stderr）**未在本版修復**，升級者若啟用 `REDIS_PASSWORD` 請確認密碼正確、並留意容器 stderr 日誌。

### 相容性注意（升級前必讀）

- **去重鎖 TTL 條件**：worker 啟動時驗證 `AI_DEDUPE_LOCK_SECONDS × 1000 ≥ AI_TIMEOUT_MS + 5000`，不成立即拒絕啟動。
  預設值（`AI_DEDUPE_LOCK_SECONDS=45`、`AI_TIMEOUT_MS=30000`）不受影響；自訂 `AI_DEDUPE_LOCK_SECONDS` 低於 35（在 `AI_TIMEOUT_MS=30000` 下）者 MUST 調高。
- **Docker Engine 25+／Compose 2.20.2+**：compose 的 api healthcheck 使用 `start_interval`，更舊的 Engine 不認得此鍵、更舊的 Compose 會拒絕整份檔案。
- **跨 process e2e 需 Compose 2.24.4+**：`docker-compose.e2e.yml` 用到 `!reset`／`!override`；只影響 `pnpm test:e2e`，一鍵 demo 本身仍只需 2.20.2+。
- **`WS_AUTH_SECRET` 語意收緊**：有設時 `system/metrics`、`ai/*`、`job/status` 只送給通過 `machine/subscribe` token 的連線；
  `POST /diagnoses` 的 `socketId` 也必須是在線且已授權的連線。連線須在 `WS_AUTH_GRACE_MS`（預設 10000）內完成授權，否則以 `1008` 關閉。
  未設 `WS_AUTH_SECRET` 時行為不變（連上即授權）。
- **demo 入口預設只綁本機**：web 容器改為 `${WEB_BIND:-127.0.0.1}:8080:8080`；要讓同網段其他機器連進來示範，需在 host shell 或 repo 根 `.env` 設 `WEB_BIND=0.0.0.0`。
- **HTTP 400 的錯誤碼**：`POST /diagnoses` 驗證失敗時 `issues[].code` 由 `invalid_string` 變為 **`invalid_format`**（Zod 4）。
- **`POST /diagnoses` 新增回應**：`machineId` 不在機台名冊 → **404**；`socketId` 不在線或未授權 → **409**（新增觸發條件，1.1.0 起 409 已用於 `jobId` 衝突；中文 message）；demo 經 nginx 時超過限流 → **429**。
- **Node 最低版本**：root `package.json` 新增 **`engines.node >=22.12`**（Vite 7／plugin-vue 6 需求；1.0.0 沒有 `engines`，中間的 `>=22` 只存在於未發布的修復分支）；pnpm 升 **10.34.5**（`packageManager` 釘版，經 corepack 取得）。
- **既有 demo volume**：`TELEMETRY_TTL_SECONDS` 會以 `collMod` 套到既存 collection，demo 範本預設改為 86400（1 天）。
- **數值 env 改為 fail-fast**：api 與 worker 的數值變數（`API_PORT`／`REDIS_PORT`／`WS_*`／`MOCK_TELEMETRY_INTERVAL_MS`／`TELEMETRY_TTL_SECONDS`／`AI_*`／`FAKE_AI_*`／`WORKER_CONCURRENCY`／`REDIS_COMMAND_TIMEOUT_MS`）留空＝預設，但設成 0、負數、小數或非數字即**拒絕啟動**（1.0.0 多為靜默回退）；另新增下限 `WS_HEARTBEAT_MS ≥ 1000`、`MOCK_TELEMETRY_INTERVAL_MS ≥ 5`，`WORKER_INSTANCE_ID` 只接受 `[A-Za-z0-9._-]`。demo 容器設錯會進 `restart: on-failure:5` 並在 5 次後停止，以 `docker compose logs <服務>` 查是哪個變數。009 的 `LOG_LEVEL`／`METRICS_INTERVAL_MS`／`HEALTH_PROBE_TIMEOUT_MS` 維持回退＋warn。
- **Redis／Mongo 只綁 `127.0.0.1`**：compose 的 `6379`／`27017` 改發佈在 `127.0.0.1`，同網段其他主機連不到；需要對外時自行改 `ports`。
- **Redis `maxmemory 256mb` ＋ `noeviction`**：滿載時寫入報錯而非淘汰 key；長跑 demo 若見 `OOM command not allowed` 請 `down -v` 重設或調高上限。
- **worker 的 Redis key 改名**：`worker:heartbeat` → `worker:heartbeat:<instanceId>`、`metrics:worker` → `metrics:worker:<instanceId>`；讀這些 key 的外部腳本需改為 pattern 掃描。
- **自寫 WS client 需更新**：`machine/data` 自契約 1.1.0 起為裸 `TelemetryPoint[]` 陣列（無 envelope）、`ai/token`／`ai/done`／`ai/error` 必帶 `attempt`，且同一 `attempt` 內再次收到 `seq` 0 須視為重播並清空累積文字（見下方「asyncapi 契約版本」）。

### Added

- **契約**：`ClientControlMessageSchema`、`CreateDiagnosisBodySchema`／`CreateDiagnosisResponseSchema`、`AiStreamEventSchema`、
  `JobStatusSchema`、`WorkerMetricsSchema`，以及五個控制訊息（`TelemetryPoint`、`SystemConnected`、`MachineSubscribed`、`Pong`、
  `SystemMetrics`，另含 `SystemUnauthorized`）全部改為 Zod schema；新增 asyncapi↔Zod 漂移測試與覆蓋率測試（12 則 message 全數比對）。
- **`ai/*` 帶 `attempt`**：重試時前端可辨識換輪並清空串流文字；Copilot 任務 meta 改顯示 Attempt `N / 3`。
- **`system/metrics.persist`**（optional）：api 歷史寫入路徑的累計 `dropped`／`failed` 計數。
- **Gateway 出口閘門**：`WS_SEND_HIGH_WATER_BYTES`（慢讀者背壓）、`MAX_WS_CONNECTIONS`（連線上限，滿則 upgrade 回 503；
  有 `WS_AUTH_SECRET` 時另有未授權子上限）、`WS_AUTH_GRACE_MS`（授權期限）、違規累計 10 次以 `1008` 關閉、帶 nonce 的心跳。
- **web**：連線活性狀態（ping 後 5 秒未回 pong 即判斷線並立即重連）、TopBar「未授權」chip、Diagnose 統一連線就緒閘門。
- **worker**：`AI_MAX_OUTPUT_TOKENS`（預設 2048）、`AI_TEMPERATURE`（預設 0.2）、`WORKER_CONCURRENCY`、`REDIS_COMMAND_TIMEOUT_MS`、
  `WORKER_INSTANCE_ID`；多實例 heartbeat／metrics key（`worker:heartbeat:<id>`、`metrics:worker:<id>`），api 合併多實例快照。
- **worker 故障演練開關**：`WORKER_CHAOS_ALLOW_IN_PRODUCTION`（容器內演練需明確放行）。
- **運維**：redis／mongo healthcheck 與 `service_healthy` 依賴、各服務資源上限與 log 輪替、nginx 對 `/diagnoses` 限流（`429`）與 `/ws` 連線數限制、安全 header／CSP／gzip。
- **README 自動檢查**（`fix/20260927-review02-batch-cd`）：`info.version` 字串與 `asyncapi.yaml` 一致、環境變數表涵蓋兩份 `env-schema.ts` 全部 key。
- **本檔 `CHANGELOG.md`**（`fix/20260927-review02-batch-cd`）：版本策略、產品變更與 asyncapi 契約版本紀錄。
- **測試基礎建設**（`fix/20260927-review02-batch-cd`，Batch D；指令與前置見 README「測試與品質門檻」）：
  - `pnpm test:coverage`／`pnpm check:coverage`：root `vitest.config.ts` 聚合五個套件、`@vitest/coverage-v8` 合併報告，不退步門檻 lines 60％／branches 50％。
  - `test:integration`（worker、api）：真 Redis／Mongo 整合測試（需 `docker compose up -d`；Redis db 15＋隨機前綴、Mongo 隨機資料庫、測後清理）。
  - `pnpm test:e2e`：新套件 `tests/e2e` 與 `docker-compose.e2e.yml`，以獨立 compose 專案 `flow-gatekeeper-e2e`（只開 `127.0.0.1:18080`）跑四個跨 process 場景，跑完 `down -v`。
  - `pnpm test:mutation`：Stryker 變異測試（五個接線層核心檔，`break` 70）與 `nightly-mutation.yml` 排程 workflow。
- **worker `AI_PROVIDER`**（預設 `gemini`；`gemini`｜`fake`）與 `FAKE_AI_TOKENS`（預設 20）、`FAKE_AI_TOKEN_DELAY_MS`（預設 500）：`fake` 為測試替身，不呼叫 LLM、不需金鑰、輸出固定假診斷逐段串流，**僅供 e2e 與演練**；`NODE_ENV=production` 下允許但啟動 warn，非法值拒絕啟動。

### Changed

- **技術棧升級**：NestJS 10 → 11.2.6（Express 5）、`@nestjs/bullmq` 12、Vite 5 → 7.3.6、`@vitejs/plugin-vue` 6、vue-tsc 3、
  Pinia 2 → 3、vitest 2 → 4.1.11、Zod 3 → 4.6.5（移除 `zod-to-json-schema`，改用內建 `z.toJSONSchema`）、pnpm 9 → 10.34.5。
  web bundle 因 Zod 4 由約 190 kB 增為約 224 kB（gzip 約 76 kB），為已接受的代價。
- **LLM SDK**：遷移至 `@google/genai`，以 `responseJsonSchema` 走原生 structured output；逾時改 `AbortSignal` 真正中止底層串流。
- **LLM 限流**：改為 worker 取鎖後的 Redis 固定窗（`ai-rpm:<分鐘>`，`AI_RPM`），cache 命中與等待者不吃額度（取代 BullMQ limiter）。
- **重試語意**：非最終嘗試不送 `ai/error`；不可重試錯誤直接結束；`GEMINI_API_KEY` 任何環境皆可留空，缺席時診斷立即以 `provider_error` 失敗、不重試。
- **遙測寫入**：api 改有上限 buffer 每秒批次落庫，推送節拍不受資料庫延遲牽制。
- **容器**：base image tag＋digest 雙釘；web runtime 改非 root 的 `nginx-unprivileged`；runtime image 不再帶 packages 的 src／測試；
  redis／mongo `restart: unless-stopped`；web 等 api healthy 才啟動。
- **契約版本**：`asyncapi.yaml` `info.version` 1.1.0 → **1.2.0**（明細見下方「asyncapi 契約版本」）。
- **產品版本**（`fix/20260927-review02-batch-cd`）：五份套件 `package.json` 的 `version` 由 `0.1.0` 對齊為 `1.1.0`，root `package.json` 新增 `"version": "1.1.0"`。
- **Gateway 關閉逾期回收**（`fix/20260927-review02-batch-cd`）：已發 `close(1008)` 但對端不回 close frame 的連線，由發出 close 時掛上的**逐連線計時器**在 `min(WS_HEARTBEAT_MS, WS_AUTH_GRACE_MS)` 到期後 terminate（reason `close-not-honoured`），不再依賴心跳或授權 sweep 的檢查間隔——**未設 `WS_AUTH_SECRET` 時（違規累計 10 次的關閉）也生效**，此前只在有密鑰時由授權 sweep 處理。
- **CI**：`test` 步驟改為 `pnpm test:coverage`（含門檻、上傳 lcov artifact），加 `permissions: contents: read`、`concurrency`、`timeout-minutes: 20`；仍只保留手動觸發。

### Fixed

- worker 去重鎖真正生效（取鎖後 double-check cache、隨機鎖值＋Lua compare-and-del）、逾時後殭屍串流不再送 token。
- 空脈絡短路：無任何遙測／錯誤／維修資料的機台直接回不可重試的 `ai/error(no_context)`，不打 LLM。
- 輸出被截斷（`max_tokens`）視為不可重試的 `schema_invalid`，不再重打同一 prompt。
- web 機台卡片選取態幾乎不可見（自 004 起的色票問題）；重連退避改在 `machine/subscribed` 才歸零，修正 token 錯誤時約 1 秒週期的無限重連。
- 背景分頁的溢位合併保留每台狀態轉換點，Event Stream 不再漏掉背景期間的 warning／critical；丟棄筆數計入背壓比值。
- `TELEMETRY_TTL_SECONDS` 改值對既存 collection 真正生效（`collMod`）；errorlogs 補 TTL index。
- worker bootstrap 失敗改記 `fatal` 並非零退出，交給監督者重啟。
- 行動版 bottom-sheet 的 focus trap 與 a11y、StreamingPanel 不再逐 token 朗讀。

### Security

- **日誌遮蔽**：共用 logger `redact` 遮蔽 Redis 連線錯誤中的 `REDIS_PASSWORD`（此前認證失敗時密碼會以明文進日誌）。
- Gateway 輸入加固：`safeParse` 全部客戶端控制訊息、`maxPayload` 16 KiB、`WS_ALLOWED_ORIGINS` Origin 白名單、`machineIds` 與名冊取交集。
- compose 的 Redis／Mongo 只綁 127.0.0.1；web 入口預設只綁本機（`WEB_BIND`）；Redis 可經 `REDIS_PASSWORD` 啟用 `requirepass`。
- `pnpm audit --prod` 歸零（NestJS 11／Express 5 升級後）。
- chaos 故障注入在 `NODE_ENV=production` 預設拒絕武裝。
- worker `diagnoses` 的 `jobId` 索引：Mongo 7 下不同名的 unique 與非 unique `{ jobId: 1 }` 並存時，改為優先認 unique，不再誤 drop 既有索引（`fix/20260927-review02-batch-cd`）。
- worker `AI_PROVIDER=fake` 時不再發出 `GEMINI_MODEL` thinking／`AI_MAX_OUTPUT_TOKENS` 誤導性警告。

### Internal

- 日誌節流器（`LogThrottle`、`ConnectionErrorThrottle`、`ERROR_LOG_THROTTLE_MS`）收進 `@flow-gatekeeper/shared/logging`，api 與 worker 共用一份；worker 連線錯誤節流 key 只用連線名。對外行為不變。
- Gateway 以逐連線 `closeTimer` 為關閉中的單一來源（`isClosing()` 由其推導，違規與授權逾期共用 `requestClose()`）；web `useDiagnoseTrigger` 的 `hasClient` 改由 `connectionBlockedReason` 推導。

## [1.0.0] - 2026-08-05

第一版正式發布（Feature 001–009）。tag `1.0.0`（`3e94ac2`；原名 `v1.0.0`，2026-09-28 更名）；當時 `asyncapi.yaml` 的 `info.version` 為 0.1.0，五份套件 `package.json` 為 `0.1.0`，root `package.json` 無 `version` 與 `engines`。

---

## asyncapi 契約版本

`asyncapi.yaml` 的 `info.version` 獨立於產品版本（見「版本策略」）。本節同時記錄 HTTP（`POST /diagnoses`）的契約變化，
核對來源為 `git log -p -- asyncapi.yaml` 與 `packages/contracts/src/`。

### 1.3.0（產品 2.1.0 起）

asyncapi `info.version` 1.3.0，向後相容的 minor（第三輪審查 quick-fix，`fix/20261018-review03-quickfix`）。**schema 沒有改動**（12 則 message 的結構、asyncapi↔Zod 漂移比對皆不變），變的是 wire 行為與描述：

- **runtime 接受範圍收窄（WS 入站限速，API-13）**：`machine/subscribe` 與 `ping` 共用每連線 token bucket，穩態 20 則／秒、容量 40；桶空時到達的訊息不解析即丟棄，每則計一次違規，與畸形訊息、schema 不符、錯誤 token 共用違規計數，達 `WS_MAX_VIOLATIONS`（10）以 close code `1008` 關閉。描述寫在 `machine/subscribe` 與 `ping` channel。
- **語意變更（協定層 ping，API-13，使用者裁決 13）**：client 送來的協定層 ping frame（opcode 0x9）不再自動回 pong（`autoPong: false`）；消費端判活 MUST 用應用層 `ping`／`pong` 訊息。應用層 `pong` 不受背壓影響、送出緩衝超過高水位時照回，放大量由入站 token bucket 限制。伺服器探活（server 送協定層 ping、client 回 pong）不變。`ping`／`pong` 描述同步改寫（合併門第 2 輪時 1.3.0 尚未發布，本項直接併入 1.3.0、不另升版）。
- **消費端義務更新（AR-S8）**：`ai/token`／`ai/done`／`ai/error` 的 `attempt` 說明——同一次執行內 `seq` 嚴格遞增，同一 `attempt` 內收到未遞增的 `seq`（`seq <= 上一個 seq`）即 MUST 視為新一次執行並清空已累積的串流文字。1.2.0 只要求「同一 attempt 內再收到 `seq` 0」時重置；新規則涵蓋它（`seq` 0 必然不大於上一個），並補上新執行的 `seq` 0 在 Pub/Sub 遺失的情形。
- **HTTP 契約（API-7／API-17）**：`POST /diagnoses` 的 body 上限由 express 預設 100 kb 收窄為 16 kb，超過回 **413** `{"statusCode":413,"message":"Payload too large"}`；body 不是合法 JSON 的 400 改為固定的 `{"statusCode":400,"message":"Invalid JSON body"}`（原為 `{message: <JSON 解析錯誤原文>, error: "Bad Request", statusCode}`，不再回顯本文、少了 `error` 欄位）。body-parser 自己產生的其他 4xx 改為固定 reason phrase（charset／encoding 不支援的 415 為 `Unsupported Media Type`，`request.aborted`／`request.size.invalid` 的 400 為 `Bad Request`），非 `HttpException` 的 5xx 除 500 回 `Internal server error` 外回標準 reason phrase。契約不符的 400（`issues[]`）與 controller／service 回的 404、409、415、503 及 201 回應不變；回應標頭不再帶 `X-Powered-By`。

### 1.2.0（產品 1.1.0 起）

asyncapi `info.version` 1.2.0，向後相容的 minor：

- **新增欄位**：`system/metrics` 新增 optional `persist: { dropped, failed }`（皆 `integer`、`minimum: 0`），為 api 程序啟動以來的累計值、
  不隨視窗歸零；舊版 api 不送此欄，消費端 MUST 容忍其缺席。
- **傳送範圍語意**：`job/status`、`ai/token`、`ai/done`、`ai/error`、`system/metrics` 在設定 `WS_AUTH_SECRET` 時只送給已通過
  `machine/subscribe` token 檢查的連線（未設時送給所有連線）。
- **數值下限**：`system/metrics` 的 `windowMs`（`minimum: 1`）與 `queue.waiting`／`queue.active`／`queue.failed`、`wsConnections`（`minimum: 0`）共五處補上 `minimum`。
- **新增消費端義務**：`ai/token`／`ai/done`／`ai/error` 的 `attempt` 說明——stalled 重派（worker 崩潰）不會增加 `attemptsMade`，
  因此**同一 attempt 內**也可能再次收到 `seq` 0；消費端 MUST 把 `seq` 0 視為新一次執行並清空已累積的串流文字。
- **語意更正（CT-4）**：`system/metrics.collectedAt` 的描述由「新鮮度以此判定」改為「僅供顯示與稽核；新鮮度以消費端收訊時刻判定」，與 web `metrics.store` 自 `a85509d` 起的實作一致（避免時鐘偏差）。結構未變。
- **runtime 接受範圍收窄**（隨 Zod 4 升級，asyncapi 結構未變）：時間戳（如 `WorkerMetrics.snapshotAt`）改以
  `z.iso.datetime({ offset: true })` 驗證 RFC 3339；UUID 欄位改 `z.uuid()`（檢查 RFC 4122 版本位）。生產端 `toISOString()`／`randomUUID()` 皆通過。
- **HTTP 契約**：`POST /diagnoses` 的 400 回應 `issues[].code` 由 `invalid_string` 變 `invalid_format`；新增 **404**（`machineId` 不在名冊）；
  **409** 新增觸發條件：`socketId` 不在線或未授權（1.1.0 起 409 已用於 `jobId` 衝突）；檢查順序為名冊 404 → `socketId` 409 → `jobId` 冪等。

### 1.1.0（第一輪審查修復，未隨任何產品版本發布）

asyncapi `info.version` 由 0.1.0 直接改為 1.1.0（`cffb306`；沒有 1.0.0，見「版本策略」的歷史說明）：

- `machine/data` 由單筆 `TelemetryPoint` 改為**裸陣列**（無 envelope，每個元素自帶 `type`）。
- `ai/token`／`ai/done`／`ai/error` 新增必填 `attempt`（`integer`、`minimum: 1`）；同一 `jobId` 重試時 `seq` 從 0 重來，消費端在 `attempt` 改變時清空串流文字。
- `machine/subscribe` 補上限：`token` `maxLength: 512`、`machineIds` `maxItems: 50`、每個 id 長度 1–64。
- `WorkerMetrics` 的計數欄位補 `minimum: 0`。
- HTTP：`POST /diagnoses` 以 `CreateDiagnosisBodySchema` 驗證並具冪等性（201／400／415／409／503）。
- 契約層全面 Zod 化，並以漂移測試比對 asyncapi 與 Zod。

### 0.1.0（產品 1.0.0）

asyncapi `info.version` 0.1.0：Feature 001 起草、002 擴充 WS 控制訊息、009 新增 `system/metrics` 的初版契約，隨 1.0.0 發布。
