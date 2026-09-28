# 2026-09-27 第三輪全面技術棧與架構審查（Research Review 03）

| 項目 | 內容 |
| --- | --- |
| 審查日期 | 2026-09-28（第二輪 Batch A～D 與最終兩段式審查併入 `develop` 之後；檔名沿用本系列的 `20260927` 編號） |
| 審查對象 | `develop` @ `4c43d18`（`merge(review02-cd): 併入 fix/20260927-review02-batch-cd`；其下 `898ccfc merge(fix-review02)`、`63b6f66 merge(docs)`、`6be71c6 merge(upgrade)`、`a8ef62a merge(fix-review)`）。工作樹乾淨；`develop` 領先 `origin/develop` 78 個 commit，**尚未 push** |
| 與前輪關係 | 前輪 `docs/20260927-research-review02.md` 審 `develop` @ `6be71c6`，其附錄 C 逐項記錄了 Batch A～D 的修復宣稱與「未修—列入後續」清單。本輪三個目標：(a) 驗證附錄 C 的「已修」宣稱與最終審查是否屬實、有無回歸；(b) 找前兩輪未發現的缺陷；(c) 重新判斷架構級優化方向與 roadmap。**前輪已列、本輪無新證據的殘留項不重複**（以 ADR-002 §6.5／§6.5.1 backlog 為準） |
| 方法 | 8 個獨立審查 agent（Opus 5.5）分面向平行、全程唯讀：api、worker、web、contracts／shared／asyncapi、infra／CI、測試與程式品質、文件與 SDD 流程、跨 process 架構與技術棧。統籌者（Fable 5.1）另行實跑全套檢查、交叉比對、去重、抽查關鍵證據（原始碼、探測 log、`gh repo view`）。實測項目標「實測」，推論項目標「推理」 |
| 全套檢查（實跑） | `contract:lint` 0 error；`-r build` 5/5；`-r typecheck` 5/5；`-r lint` 0 error 0 warning；`test:coverage` 94 檔 **982 passed / 0 failed**（隔離輸出目錄，測試 agent 與統籌者各實跑一次結果相同；lines **81.52%**、branches **76.56%**、statements 79.88%、functions 73.19%，門檻 60／50，與 Batch D 宣稱逐位一致）；整合測試 **27/27**（worker 20＋api 7）；e2e **5/5**（5 m 57 s）；Stryker 單檔重測 processor **73.86**、gateway **68.47**（break 70）；web bundle **226.41 kB**（gzip 76.09 kB；前輪 224.32／75.62）；`pnpm audit` **3 moderate**（皆為 `qs`，經 `@stryker-mutator/core` 間接引入，dev-only；`--prod` 為 0）。**注意**：coverage 與其他 vitest／Stryker 行程並行時會互相污染（TQ-15），統籌者首次並行實跑得到 979/982、71.91／67.33 且三個 `.vue` 被靜默排除，隔離重跑後消失 |
| Finding 編號 | 沿用穩定 ID。本輪新發現起編：`API-11`、`WK-13`、`WEB-13`、`CT-13`、`INF-14`、`TQ-14`、`DOC-12`、`AR-4`／`AR-A10`／`AR-S7`。第二輪 §4 曾以「DOC-9～D15」範圍寫法列 Low，`DOC-12` 起可能與之撞號（DOC-33）；**本文 `DOC-12` 以後一律指第三輪新發現** |
| 各面向完整報告 | 統籌者 scratchpad `review03/{api,worker,web,contracts,infra,tests-quality,docs-process,architecture}/report.md`，並附探測腳本、故障實驗 log、變異清單與結果（未納入 repo） |

---

## 0. 結論摘要

1. **第二輪 Batch A～D 與最終兩段式審查的宣稱屬實，沒有回歸。** 附錄 C 標「已修」的項目八個面向逐項核對全部成立，關鍵項皆以真實 Nest app、真 BullMQ／Redis／Mongo、headless Chromium 實測重現。覆蓋率 81.52／76.56 隔離重跑逐位相符；57 個手工變異殺死 54 個；e2e 五場景斷言有實質內容。**唯一例外是 CT-1／API-1「Redis 密碼不進日誌」只修了一半**（見 2）。
2. **一個 P1：producer `Queue` 沒掛 `error` listener。** BullMQ 在無 listener 時直接 `console.error(err)`，Redis 密碼以明文寫進 api 的 stderr，約 80 秒 13 次、無節流、非 JSON，完全繞過第二輪加的 pino `redact`（實測，統籌者複核原始碼與 log）。同一根因還有兩條旁路：`redact` 只涵蓋一層萬用字元與 `err` 鍵（CT-13），`PinoLoggerService` 把 Error 物件 `JSON.stringify` 成 msg 讓 message／stack 全失且可帶出 `command.args`（API-11）。修法都在 shared logger 與 api adapter，合計約半天。
3. **「完成語意」的縫隙比第二輪描述得更精確，並推翻 FMEA 一列。** 實測 api 重啟**不會**讓前端卡 45 秒：api 重啟必斷 WS，web 重連後立即標「連線中斷」，Retry 命中快取。真正會卡到 45 秒 watchdog 的是三種情況：(a) WS 沒斷但 Pub/Sub 斷（實測以 `CLIENT KILL TYPE pubsub` 重現，收到 `completed` 卻無 `ai/done`，**api 全程零日誌**）；(b) worker 對 `ai/done` 是 fire-and-forget，而 api relay 假設 `completed` 一定晚於 `ai/done`，兩訊號分走四條 Redis 連線、沒有順序保證（AR-5／WK-14，worker 與架構兩個 agent 各自從不同端指出）；(c) Redis 停頓超過 30 秒 lock 遺失，同一 jobId 被執行兩次、前端收到兩則 `ai/done`（實測）。這些全部收斂在 012-lite，且 012-lite 的契約代價很小。
4. **AI 成本放大兩處。** 同簽章請求失敗時不去重：持鎖者失敗即放鎖，等待者接著自己打 LLM，實測 2 個 job 共打 6 次（WK-13），放大剛好發生在供應商出狀況時。BullMQ 的 lockDuration／stalledInterval／maxStalledCount 全用預設（30 s／30 s／1），e2e 量到的 92 秒空窗是結構性的（AR-S7）。
5. **Gateway 出口閘門留了一個入站放大口。** `pong`／`machine/subscribed` 不受高水位限制、入站無速率上限；暫停讀取的 client 灌 ping，10 秒內 server 緩衝達 4.13 MB（高水位的 63 倍）且連線存活到心跳回收（API-13，實測）。另外 Redis 不可達時 `app.close()` 無限期卡住，compose 的 15 秒 grace 到期後被 SIGKILL（API-12，實測）。
6. **測試基礎建設可信，但有四個脆弱點會在 CI 上第一次就咬人。** 三支 `main.test` 在 `it` 內冷載入整個依賴圖，並行負載下 20／30 秒必逾時（TQ-14，統籌者與兩個 agent 都撞到）；`coverage/` 與 `reports/` 是共用可變狀態，並行跑會靜默排除 `.vue` 且仍過門檻（TQ-15）；processor 的 liveness 斷言用 `every()` 對空陣列恆真（TQ-16，Stryker 三處 `touch` 全存活）；Gateway 關閉路徑零斷言，是 gateway 分數壓在 70 以下的主因（TQ-18）。
7. **CI 從未在 GitHub 跑過，且停用理由已不成立。** 78 個 commit 未 push、`nightly-mutation.yml` 不在 `main`（schedule 只從預設分支觸發），Batch D 的 CI 與 mutation 常態化只在本機成立（TQ-19）。`gh repo view` 顯示 repo 是 **PUBLIC**，ADR-002、指南與兩個 workflow 以「私有 repo 省 Actions 分鐘」為前提停用 push／PR 觸發的理由失效（DOC-18，統籌者複核）；nightly 每日對 1128 個 mutant 無變更照跑（INF-14）。要不要恢復自動 CI 需使用者決定。
8. **文件層有六個 release 閘門未過。** 「待併回」殘留三處應填 `4c43d18`（DOC-12），且規則本身有死結——merge 前回補真實來源、又禁止直接 commit `develop`、但 hash 要 merge 後才存在（DOC-13）；CHANGELOG「相容性注意」漏了五類會讓升級者踩雷的變更（DOC-14）；宣稱 SemVer 卻未宣告公開介面，v1.0.0→v1.1.0 含多項部署者不相容變更（DOC-15）；010-lite 的範圍只存在於第二輪報告（DOC-16）；backlog 有孤兒——第一輪 §3.1 a／c／d／f 沒人追蹤、C.9 兩項重構建議內容已遺失（DOC-17／WK-18）。
9. **Roadmap 改為 quick-fix（約 1 人日）→ 012-lite → 010-lite（縮小）→ 011。** 使用者看得到的「後端成功、畫面失敗」全部在 012-lite；`JobStatus.result` 欄位早已存在、QueueEvents 的 `completed` 事件本身就帶 `returnvalue`，WS 契約只是 additive；`JobRoutingRegistry` 本來就是 rebind 的載體，移進 012-lite；010-lite 的 `protocolVersion` 等 012-lite 定案後一次升版。**技術棧全部維持、不換任何核心元件**；自行實作 Redis Streams 定案為不做；建議新增 ADR-003「診斷完成語意與結果讀取」。

---

## 1. 第二輪修復與最終審查的回歸驗證

| 面向 | 驗證方式 | 結果 |
| --- | --- | --- |
| api（API-2～6、§1.1 連線上限、授權期限、closeTimer `f2d9cb0`、TQ-2／TQ-6／TQ-11、nest-logger helper） | 單元 266、typecheck、整合 7；以 `dist` 照 `main.ts` 相同組合根起真實 Nest app，ws client／原始 TCP 五支探測（HTTP 狀態碼、慢讀者／偽造 pong／ping 洪水、Redis 密碼錯誤、關閉時序、logger adapter） | 全部成立（實測）：真暫停讀取者 2.1 s 回收、偽造 pong 者 1.65 s 回收、MAX=20 第 11 條未授權 503、grace 2 s 實測 2.88 s 1008、不回 close frame 2005 ms 後 terminate 並釋放名額、離線／未授權 socketId 409、10 次錯 token 5 ms 內 1008。**CT-1／API-1 只修一半**（§2.1）。附註：完全停讀者必先在第 2 tick 被心跳回收，3-tick 慢讀者分支只對「讀得慢但仍回 pong」者生效 |
| worker（WK-1／3／5、節流、TQ-1／4／5／10／13、INF-1、限流 `moveToDelayed`、去重、§3.1 b／e、`3e1436a`） | 單元 219、typecheck、整合 20；真 BullMQ＋fake provider 跑去重、限流、空脈絡、Mongo validator 寫庫失敗、同簽章逾時、錯誤 Redis 密碥、production chaos 守衛 | 全部成立（實測）：錯密碼啟動 log 7 行密碼 0 次、10 s 後 fatal exit 1；`no_context` 0.2 s 回 `ai/error` 且不退避、不計 rpm；AI_RPM=1 延到下一窗、`attemptsMade 1`／`attemptsStarted 2`；同機台兩 job 一 miss 一 hit、`diagnoses` 1 筆；chaos 在 production 預設拒絕、ALLOW=true 約 2 s fatal。WK-10 仍部分（缺 thoughts） |
| web（WEB-1／2／3、TQ-3、§3.3 a／b／c、`useDiagnoseTrigger`、attempt 換輪、AR-S7 chip、26 支元件測試） | typecheck／lint；web 測試 318/319（1 支即 TQ-14）；headless Chromium 讀 computed style（三種狀態 × focus／hover／blur、行動版）；假 Gateway 黑洞模式；20 個手工變異 | 全部成立（實測）：選取態邊框 `rgb(79,163,255)`、底色 `rgb(15,27,40)`、1 px accent outline；黑洞 13.1 s 轉 Reconnecting、恢復 0.88 s 重連；重連後 active 任務轉 failed 並保留殘文；換輪 AAABBB→CCC、遲到舊輪 token 忽略、meta「2 / 3」。§3.3 c 仍部分（`shared/components/{TopBar,MetricsPanel,AppLayout}.vue` 反向匯入 `domains/`）。變異殺 15／存活 4／等價 1 |
| contracts／shared（CT-1／2／4／12、DOC-2、兩支文件一致性測試） | contracts 125、shared 53、Spectral；假 Redis `WRONGPASS` 實測 redact；21 個手工變異；`git diff 3e94ac2..4c43d18` 逐項對 CHANGELOG 契約小節；web bundle 殘留檢查 | CT-1 主要路徵已修（`{err}`、`{error:err}`、AggregateError、`logger.error(err,msg)` 皆不外洩）但有旁路（CT-13）；CT-2／4／12 已修；DOC-2 asyncapi 1.1.0／1.2.0 兩節與 diff 逐項對得上。CT-5／7／8／9／10／11 未修與附錄 C 一致 |
| infra／CI（INF-1～13、Batch A 第 4／6 項、coverage 上傳、nightly 結構、e2e 隔離） | 三種 compose 組合 `config -q` 並渲染比對；乾淨 clone 模擬；模擬 Docker builder 條件的 frozen install＋`deploy --legacy`；Docker Hub API 比對 digest；`audit`／`dedupe --check`；`mutation.json` 統計。**未實測** image build／history／restart 行為（agent 執行時 Docker 引擎未啟動） | INF-1／2／3／4／5／6／9 已修；INF-6 補強：worker legacy deploy 91 個套件全在 lockfile、無 dev 依賴（本機 store，非乾淨 BuildKit cache）；四個 base image digest 與 Docker Hub 一致。INF-7／8／10／11／12／13 仍餘項，INF-12 規模擴大（builder 633 套件 vs 部署 91，Stryker 與 coverage-v8 進 builder） |
| 測試與品質（Batch D 全部、C.8 數字、C.9 最終審查） | `test:coverage` 隔離重跑；57 個記憶體內手工變異（baseline 35/35、sanity 31/35 紅）；e2e 一次；Stryker 單檔 ×2；worker 單元連跑 8 次 | 982/982、81.52／76.56、16 個 `.vue` 全部量到；54/57 killed（存活 P3 60 里程碑位置、R5 delayed 寬限；W5 等價）；e2e 五場景斷言精確（progress `[0,20,40,60,80,100]`、seq `0..19`、attempt `{1}`、SIGKILL 場景 kill→waiting 96.8 s）；processor 62.7→**73.86**、gateway 66.5→**68.47**（單檔仍 <70）。C.8 提到的 worker 偶發失敗研判即 `main.test` import timeout（8/8 綠，兩次高負載失敗皆為該支） |
| 文件與流程（DOC-1～11、R1～R4、S1、C1／C3、D13／D14、G1、Batch C 八項） | 逐檔讀取＋`git log`／`show`／`diff`；README 26 種 pnpm 指令逐一對 `package.json`；env 表與兩份 `env-schema.ts` 逐鍵；憲章 1.5.0 三項例外對程式碼；`gh repo view`／`gh release view` | 全部已修；DOC-S1 部分（008 無「已變更」橫幅）、DOC-8 部分（backlog 不完整，DOC-17）。git 流程 38 commit／5 merge 全合規；demo 影片確在 v1.0.0 release 附檔 |
| 架構（§5.1 狀態清單、§5.2 FMEA、§5.3 模組邊界） | 拋棄式 compose project `fg-r03-arch`（fake provider）四個故障情境：api 優雅重啟、Redis pause 20 s、Redis pause 50 s、`CLIENT KILL TYPE pubsub` 每 50 ms × 45 s；容器內量模組 import 時間 | §5.1 由 10 處變 **15 處**（Batch B 新增授權集合、違規計數、closeTimer、背壓、連線配額；另補漏 mock telemetry producer）；§5.2「api 重啟 `ai/done` 遺失」**不成立**（實測），新增「WS 沒斷、Pub/Sub 斷」一列；§5.3 `useDiagnoseTrigger` 與 shared logging 已收斂，Gateway 拆分／`JobRoutingRegistry`／`infra.ts` 未做 |

---

## 2. P1：應立即修

### 2.1 API-1（前輪補強）｜producer `Queue` 沒掛 `error` listener，Redis 密碼明文進 stderr（**實測**，統籌者複核）

- **證據**：`apps/api/src/modules/jobs/jobs.module.ts` 與 `jobs.service.ts:81-85` 都沒有對 `@InjectQueue` 取得的 Queue 掛 `on("error")`；bullmq 5.79.2 `classes/queue-base.js:86-99` 在 `emit('error')` 無 listener 時 catch 後直接 `console.error(err)`。探測 log（`review03/api/wp.stderr.log`）以 `util.inspect` 印出 `command: { name: 'auth', args: [ 'WRONG-PASSWORD-SENTINEL-42' ] }`，約 80 秒 13 次；Redis 不可達時則是 ECONNREFUSED 堆疊 10 次。無節流、非 JSON。stdout（pino）為 0 次，所以第二輪附錄 C.2 的「已修」只對 pino 路徑成立。
- **影響**：只要 `REDIS_PASSWORD` 設錯或 Redis 短暫拒絕認證，密碼就進容器 stderr（compose 的 json-file log 會保存）。第二輪 §8「祕密衛生」結論再次被部分推翻。
- **修法**：`JobsService`／`JobsModule` 的 `onModuleInit` 對 queue 呼叫既有的 `attachThrottledErrorLog`，錯誤走 `plog.warn({err})`，ready 訊號仿照 `queueEventsConnection`；補 1 支「Queue 有 error listener」單測。worker 端的 Queue／FlowProducer 一併確認。約 0.5 小時。
- **同根旁路**（列 P2，見 §3.1）：CT-13（redact 深度）、API-11（adapter 把 Error stringify）。三者一起修才能把「Redis 錯誤物件」這條路徑封死。

---

## 3. P2：應排程修

### 3.1 祕密衛生旁路（contracts／api 互相印證）

- **CT-13｜redact 可被繞過（實測）**：`packages/shared/src/logging/index.ts:31-37` 的 `REDACT_PATHS` 最多只涵蓋一層萬用字元，serializer 只處理 `err` 鍵。巢狀兩層（`{ctx:{error}}`）、陣列（`{extra:[err]}`）、`JSON.stringify(err)` 進 msg 三種寫法都讓 `REDIS_PASSWORD` 明文進日誌；`PinoLoggerService.write`（`pino-logger.service.ts:141-143`）以 `.error(err)`、`.warn(msg, err)`、`.log({err})` 呼叫也外洩。目前沒有呼叫點這樣寫，屬潛在回歸面。修法：`formatters.log` 全深度執行 `stripCommandArgs`；adapter 把 Error 物件導到 `err` 鍵；補回歸測試。1–2 小時。
- **API-11｜`PinoLoggerService` 把 Error `JSON.stringify` 成 msg（實測）**：`pino-logger.service.ts:104`。Nest 11.2.6 `base-exception-filter.js:51-52` 對非 `HttpException` 呼叫 `logger.error(exception)`，日誌只剩 `msg:"{}"`，message 與 stack 全失；`ReplyError` 則 msg 含 `"args":["…"]`。真實 app 送 413 時記一行 level 50，可被無節流觸發（API-17）。影響：日後任何漏接的非 Http 例外都無法診斷。修法：`rawMessage instanceof Error` 時放進 `bindings.err`、msg 取 `err.message`；加全域 `ExceptionFilter` 把 <500 的 http-errors 降為 warn 並節流（合修 API-7／API-17）。1–2 小時。

### 3.2 完成語意與跨 process 因果（worker／api／架構三方印證）

- **AR-5／WK-14｜`ai/done` fire-and-forget，`completed` 晚於 `ai/done` 沒有因果保證（推理，統籌者複核原始碼）**：worker `processor.ts:98` 對所有事件（含終態 `ai/done`）`void publisher.publish(...)` 後直接 return，BullMQ 在另一條連線 XADD `completed`；api `job-status-relay.service.ts` 於 `completed` 刪綁定，`ai-stream-relay.service.ts:18-20` 假設 `ai/done` 一定先到。兩訊號分走四條連線（worker pub／BullMQ；api subscriber／QueueEvents XREAD），Redis 與 libuv 皆不保證跨連線順序。pub 積壓時屬競態；pub 正在重連時 `enableOfflineQueue:false` 讓 publish 直接 reject，是**確定性遺失**。兩種情況都讓前端卡到 45 s watchdog。修法（quick-fix）：終態事件改 `await publish`（catch 記 warn）、token 維持 fire-and-forget，約 10 行＋1 測試；relay 終態後綁定保留 10 s 寬限，0.1 人日。根治：`completed` 事件的 `args.returnvalue`（bullmq `queue-events.js:98-100` 已 parse）經 schema 驗證填入 `job/status.result`（012-lite）。
- **AR-6｜Pub/Sub 中斷無聲（實測 D2）**：`attachThrottledErrorLog`（`connection-error-throttle.ts:23-30`）只聽 `error`／`ready`，對端關閉時 ioredis 只發 `close`／`reconnecting`，api 全程 0 行日誌；web reducer 收到 `completed` 仍維持 active（`copilot-reducer.ts:136-137`），只能等 watchdog（`App.vue:124`）。修法：web 在 `completed` 後 2 s 內沒收到 `ai/done` 即轉 failed 並提示「重試將命中快取」（或自動重送一次），0.2 人日；api subscriber 加 `close`／`reconnecting` 轉態日誌與計數。
- **AR-4｜Redis 停頓超過 lock 期限 → 同一 jobId 雙重執行（實測 C）**：Redis `pause` 50 s 後 worker 依序記 `could not renew lock` → `job completed` → `Missing lock … moveToFinished`；前端收到 `ai/done cached:false` 但無 `completed`；約 60 s 後同 jobId 被 stalled 重派、再跑一次、收到 `ai/done cached:true` 與 `completed`。`diagnosisTriggers` 同 jobId 兩筆（無 unique，`diagnosis-repository.ts:151-161`）、hit／miss 各記一（WK-20 同源：`isFirstAttempt` 看 `attemptsMade===0`，stalled 重派不遞增）。快取沒寫成功時會重打 LLM；`maxStalledCount=1` 被這一次停頓用掉。修法（併入 012-lite，0.5 人日）：processor 開頭以 jobId 查 `diagnoses`（WK-4 的 `findByJobId`）；trigger 以 `{jobId, cached}` 冪等寫入；hit／miss 以「首次執行」去重；ADR-003 定義 `ai/done` 可能重複。
- **WK-4 補強（實測）**：以 Mongo validator 讓 `insertOne` 失敗（code 121）：3 個 attempt 都完整串流（9 tokens）、rpm 計 3 次，worker **不送 `ai/error`**（`processor.ts:303-305` 直接 throw 不經 `fail()`），`failedReason` 原文直接下發前端。新子項：`insertTrigger`（`:305`）或 `updateProgress(100)` 失敗後重試會命中 cache，結果被誤標 `cached:true`。另 AR-A12：cache 命中路徑（`:231-233`）先 emit 才寫 trigger，LLM 路徑（`:303-307`）先寫後 emit，Mongo 斷線時前端顯示成功但 job 最終 failed。修法：`findByJobId` 重用既有結果、加 `persist_failed` code 經 `fail()` 送出、統一「先落地後宣告」。
- **AR-S7｜BullMQ 參數全用預設（推理，統籌者複核）**：`apps/worker/src/main.ts:122-146` 的 `Worker` 只設 `concurrency`，lockDuration／stalledInterval／maxStalledCount 為預設 30 s／30 s／1，這就是 e2e 量到 92 s（≈30＋2×30）空窗的結構性來源。建議改 15 s／10 s／2，上界約 35 s、低於 45 s watchdog；代價是誤判 stalled 的門檻降低，**必須與 AR-4 的冪等修法一起做**，並以 e2e 驗證。

### 3.3 AI 管線成本

- **WK-13｜失敗不去重（實測）**：`processor.ts:316-350` 持鎖者失敗後 `finally` 立即放鎖（`:341-346`），等待者取鎖、cache 仍空、自己打 LLM。實測（`AI_TIMEOUT_MS=2000`、fake provider 5 段 × 1 s）同簽章 2 個 job 共打 **6 次 LLM**，兩個 job 都走滿 3 attempt、每次都吃 `AI_RPM` 額度。放大＝同簽章請求數 × attempts，發生在供應商出狀況時；呼叫在鎖上串行，最後一個等待者要等 N × `AI_TIMEOUT_MS`；SDK 文件寫明 abort 只是 client-side 取消、照樣計費。修法：可重試失敗寫短 TTL 的 `ai-fail:<sig>`（5–15 s），等待者或新 job 看到它就不打 LLM（非最終 attempt 直接 throw 或 `moveToDelayed`；最終 attempt 送同 code 的 `ai/error`）；替代做法是失敗時把鎖 `PEXPIRE` 成冷卻期。約 0.5 天。

### 3.4 Gateway 入站與行程關閉（api）

- **API-13｜控制回覆不受背壓、入站無速率上限（實測）**：`monitoring.gateway.ts:351-353` ping 不需授權、無限制回 pong；`:75-77`／`:583-596` 只有遙測與 `ai/token` 可被略過；`:304` message handler 無速率限制。pingflood（HB 15 s、高水位 64 KiB、client 暫停讀取）：server 端 `bufferedAmount` 10 s 內達 **4.13 MB**（63 倍），線性成長，連線存活到心跳回收（≤30 s）。放大倍數約 1.8；無密鑰時可乘上 500 條連線；有密鑰時未授權者也能送 ping。demo 綁 127.0.0.1 實害低，上線前必修。修法：(a) 超過高水位時也略過 pong；(b) 每連線 token bucket（約 20 msg/s）超量計一次違規；(c) 選配：tick 時 `bufferedAmount` 超過 N 倍高水位立即 terminate。1–2 小時。
- **API-12｜Redis 故障時 `app.close()` 無限期卡住（實測）**：`job-status-relay.service.ts:228-232` `await queueEvents.close()` 無時限；`ai-stream-relay.service.ts:68-70` `quit()` 排在 offline queue；`main.ts:94-102` `app.close()` 無總時限、重入防護吞掉第二次訊號。實測 ok 155 ms；wrongpass 時 JobStatusRelay 20 s 未完成；down 時兩個 relay 都卡。compose api `stop_grace_period: 15s` 到期被 SIGKILL（137），違反 `main.ts` 自述的「收尾失敗也 exit(0)」；dev 按 Ctrl+C 卡死。worker 的 `shutdown`（`main.ts:204-232`）同樣沒有重入保護與總時限（WK-21）。修法：relay destroy 改 `withDeadline` 加 `disconnect()`；`main.ts` 對 `app.close()` 加總時限；worker 比照；補單測。1 小時。

### 3.5 web

- **WEB-4 補強（實測）**：`App.vue:45-53` 只在 `selectedMachineId` 值改變時開 sheet；行動版關掉 sheet 後，TopBar 的 Diagnose 與卡片 icon 經 `selectMachine(同一台)` 不會觸發 watch，沒有任何入口能重開，診斷在看不見的地方執行。修法：改成「選取事件」觸發 `openCopilot()`，或加一顆行動版 Copilot 入口鈕；補 App 層測試。約 1 小時。
- **WEB-24｜App／TopBar 接線層沒有測試（變異實測）**：拿掉 `copilot.onReconnect()`（`App.vue:160`）、拿掉未授權 chip、讓 TopBar Diagnose 無視閘門，三支變異下 317 支測試全綠。修法：happy-dom＋FakeWebSocket 掛載 App 做整合測試，斷言重連後任務收尾、chip、Diagnose 閘門。約 0.5 天。

### 3.6 契約閘門（contracts）

- **CT-14｜漂移測試完全不看 `channels`（實測）**：`asyncapi-drift.test.ts:28-29` 不讀 channels；channel 方向翻轉、指到錯的 message、整條刪掉，測試與 Spectral 都綠。修法：斷言 channel 名稱等於 payload 的 type const、publish 集合等於 `ClientControlMessageSchema` 成員、每則 message 恰好被一條 channel 引用。約 30 分。
- **CT-15｜「契約變更 MUST 升版」沒有自動閘門（實測）**：Zod 與 asyncapi 同步加嚴、`info.version` 不動，全綠；`http.ts` 不在任何比對範圍內。修法：新增 `contract-fingerprint.json`（`{version, sha256}`），對全部 schema 的 `toJSONSchema` 正規化結果取雜湊，雜湊變了而版本沒升就讓測試失敗。約 2–3 小時。

### 3.7 測試基礎建設（TQ-14～TQ-20，皆實測）

- **TQ-14｜三支 `main.test` 在負載下必 flaky**：`apps/{api,worker,web}/src/main.test.ts` 在 `it` 內 `await import("./main.js")`，冷 transform 整個依賴圖的時間被算進 timeout（20／30 s）。單跑 3～5 s；統籌者與兩個 agent 的並行 run 都失敗。修法：改成檔頂 `import * as mod from "./main.js"`（worker 的 `vi.mock` 會被 hoist），載入移到 collection 階段、不受 test timeout 約束，import 拋錯時整檔仍會失敗、斷言強度不變。約 15 分。不建議 mock 重依賴（失去測試意義）、移到 e2e（回饋太慢且 e2e 不在 CI）。
- **TQ-15｜`coverage/`、`reports/` 是共用可變狀態**：並行跑時一方的 `.vue` 會被 `RollupError pos 0` 靜默排除、數字掉到 71.9／67.3，而且仍過門檻不會被發現。修法：`reportsDirectory` 可用環境變數覆寫；README 註明勿並行跑兩個 coverage／mutation。約 20 分。
- **TQ-16｜liveness 斷言假綠**：`processor.test.ts:275` `expect(liveness.touch.mock.calls.every(...)).toBe(true)`，touch 從未被呼叫時 `calls` 為空陣列、`every` 回 true；Stryker 移除 `processor.ts:179/260/317` 三處 `touch()` 全部存活。後果：liveness 會把長串流中的 worker 誤判為卡住、healthcheck 轉 unhealthy（目前只示警）。修法：`toHaveBeenCalled()`。約 30 分。
- **TQ-17｜重試語意只測一半**：`processor.ts:270` `ai_timeout` 的 retryable 改 false 存活；`:274` `pe?.retryable ?? true` 改 `&&` 存活（一般 Error 第一次就變 `UnrecoverableError`）。補兩支測試。約 1 小時。
- **TQ-18｜Gateway 關閉路徑零斷言**：`monitoring.gateway.ts:190-209` stopProducer／onModuleDestroy（terminate 全部連線、`wss.close`）全部存活，另 `:326`、`:585`、`:467/:586`、`:501`、`:228/:230`。註解明寫的「關閉會掛到被 SIGKILL」防線被刪掉測試也不會發現。修法：沿用既有 harness 補 3 支，預估 gateway 拉到 72～75。約半天。
- **TQ-19｜CI 與 mutation 常態化只在本機成立**：見 §3.8。
- **TQ-20｜覆蓋率門檻比實測低 21～27 pt**：60／50 vs 81.5／76.6，刪掉約四分之一有效測試 CI 仍綠，也擋不住 TQ-15 的污染數字。修法：ratchet 到 78／73，並以 glob 為核心檔設逐檔下限（依 `coverage-summary.json` 實測值減 3）。約 10 分。

### 3.8 CI／運維

- **DOC-18／TQ-19／INF-14｜CI 從未在 GitHub 跑過，停用理由已失效（實測）**：`develop` 領先 origin 78 個 commit 未 push；`nightly-mutation.yml` 不在 `main`（目前 `main` 只有 `ci.yml`），schedule 只從預設分支觸發，release 前不會跑。`ci.yml` 只保留 `workflow_dispatch`，理由是「私有 repo 省 Actions 分鐘」，但 `gh repo view` 顯示 **`visibility: PUBLIC`**（統籌者複核）；ADR-002 :52／:217、指南 :1024、兩個 workflow 註解皆以此為前提。nightly 對 1128 個 mutant（gateway 337、useHighFrequencyWs 263、processor 241、copilot-reducer 151、job-status-relay 136）每日無變更照跑，180 分 timeout 依 2 vCPU 推估；公開 repo 標準 runner 不計分鐘且為 4 vCPU，額度論點弱化但「無變更照跑」與推估值仍成立。**待使用者決策**：是否恢復 push／PR 觸發。若恢復：`pull_request` 加 `paths-ignore`（docs、specs、md）、不恢復 push；補 `compose config -q`；e2e 改 dispatch 或每週；nightly 改每週或 develop 有變更才跑、`--incremental`＋`actions/cache`、timeout 收斂實測 ×1.3。決定後回補 ADR-002、指南、workflow 註解。

### 3.9 文件與流程（DOC-12～DOC-21）

- **DOC-12｜「待併回」殘留**：指南 :3189（§15.6 表第 5 列）、指南 :3309、`CHANGELOG.md:33` 應填 `4c43d18`；`CLAUDE.md:3-5` 的 SPECKIT 區塊漏列 `fix/20260927-review02-batch-cd`。約 5 分。
- **DOC-13｜分支內寫不出自己的 merge hash（流程設計）**：規則要求 merge 前回補真實來源、禁止直接 commit `develop`，但 hash 要 merge 後才存在；c5 的筆記「merge 前留待併回不補」就是這個死結，以後每條維護分支都會重演 DOC-12。修法：指南 §15.6 表與 CHANGELOG 改用分支名當鍵，hash 由下一條分支回填（或寫「以 `git log --first-parent --merges` 查」），並寫進 CLAUDE.md 維護分支小節。約 15 分。
- **DOC-14｜CHANGELOG「相容性注意」漏五類升級陷阱**：(1) 數值 env 全面改成設錯即拒絕啟動（api 8、worker 11 個）並新增下限（`WS_HEARTBEAT_MS ≥1000`、`MOCK_TELEMETRY_INTERVAL_MS ≥5`、`WORKER_INSTANCE_ID` 字元檢查），demo 容器會重啟 5 次後停止；(2) Redis／Mongo 改只綁 127.0.0.1（只在 Security 段）；(3) Redis `maxmemory 256mb noeviction` 未記錄；(4) heartbeat／metrics Redis key 改名（只在 Added），外部監控腳本會讀不到舊 key；(5) `machine/data` 改裸陣列、`ai/*` 必填 `attempt` 只在契約 1.1.0 小節，產品相容性段未提示自寫 WS client 需更新。約 20 分。
- **DOC-15｜SemVer 未宣告公開介面**：`CHANGELOG.md:4` 宣稱遵循 SemVer，但未宣告公開介面。v1.0.0→v1.1.0 含 DOC-14 全部、`WEB_BIND` 預設只綁本機、`WS_AUTH_SECRET` 語意收緊、HTTP 400 `issues[].code` 改名、Compose 2.20.2+／Engine 25+ 需求，嚴格 SemVer 下應為 2.0.0；契約 1.2.0 自稱「向後相容 minor」卻含 runtime 接受範圍收窄與新增消費端義務，版本策略沒定義什麼算相容。建議方案 A：在 CHANGELOG 宣告公開介面並定義「相容＝repo 內的生產者與消費者都不需改碼」，版號維持 1.1.0（約 15 分）；方案 B：改 2.0.0。**待使用者決策**。
- **DOC-16｜010-lite 範圔只存在於審查報告**：完整範圍只在第二輪 §5.4；指南 :3173 一句轉引；`infra.ts` 在 ADR 與指南 grep 皆 0。依 CLAUDE.md 規則等於未落地，下一條 feature 起草時沒有真實來源可依。修法：指南新增 010-lite 方向藍圖（範圍、明確不做、要 clarify 的問題、契約升版預估），比照 §12／§13 格式，並採納本輪 §5.4 的縮小版。1–2 小時。
- **DOC-17／WK-18｜ADR-002 §6.5.1 backlog 有孤兒**：(1) 第一輪 §3.1 a（`GEMINI_API_KEY` 缺時只 warn）、c（固定窗邊界可放行 2× 額度、延後次數無上限、窗序號用本機時鐘）、d（等待者佔槽約 80 s）、f（usage 只寫 log）、§3.2 a（`REDIS_PASSWORD` 三處設定）只存在於已凍結的第一輪報告，worker agent 逐項確認皆未修；(2) C.9 #12／#13 兩項重構建議只寫「兩項」，內容只在統籌者 scratchpad，**已遺失**；(3) worker 偶發失敗的測試（本輪已定位為 TQ-14）；(4) SDD 精簡（DOC-21）；(5) 78 個 commit 未 push 的待辦無記錄。修法：§6.5.1 補齊；#12／#13 標「內容遺失」。約 30 分。
- **DOC-19｜release 第 4 步與 DOC-9 衝突**：CLAUDE.md 規定「換版時 MUST 更新 demo 連結」，README:51 的 DOC-9 決策是維持 v1.0.0 影片（release 附檔確認存在），兩條規則互斥。修法：CLAUDE.md 改成「連結指向影片所屬版本的 release」。約 5 分。
- **DOC-20｜指南 §15.6 變成第二份 CHANGELOG**：約 165 行（:3176-3340）且規定每條分支再加一節；例如 closeTimer 在 CHANGELOG :86／:113、指南 :3326-3327、報告 C.9 各寫一次。修法見 §6 Batch F 第 1 點。
- **DOC-21｜SDD 流程精簡零進展**：`specs/` 共 10,720 行（009 一條 2,192 行），程式與測試共約 23,000 行；`diff 3e94ac2..4c43d18 -- specs` 只有橫幅與 Status 變更，也沒有「feature 收尾清單」。修法：定精簡版工件集並寫成收尾清單。約 1 小時。

---

## 4. Low（彙整，供後續追蹤）

| 面向 | ID | 一句摘要 | 修法／成本 |
| --- | --- | --- | --- |
| api | API-14 | `unauthorizedConnectionCap`＝max(10, 20%) 而 MAX 允許 1～100000，MAX ≤10 時未授權可佔滿 | `min(MAX-1, …)` 或提高 MAX 下限 |
| api | API-15 | Gateway 註解漂移：`:70` 孤兒 JSDoc、`:145-147`「只略過遙測」漏 `ai/token`、`:41-45` 慢讀者 45 s 未提心跳先回收 | 修註解 |
| api | API-16 | `removeOnComplete` 1 h／`removeOnFail` 24 h 後同 jobId 可再入列；README 冪等承諾有時效未寫 | 文件 |
| api | API-17 | body-parser 錯誤（413、charset）以 error 等級逐則記錄 | 併 API-11 全域 filter |
| worker | WK-15 | 鎖 TTL 自 `SET NX` 起算、abort 更晚起算；中間 GET／EVAL 各可耗 5 s、`updateProgress` 無逾時、LLM 後 `insertDiagnosis` 最長 20 s，5 s 餘裕不夠 | 寫庫前 Lua `pexpire` 續租，或驗證式改 `+2×cmdTimeout+20s` |
| worker | WK-16 | `bullmq ^5.21.0` 下限與程式碼依賴的 5.79 語意（`moveToDelayed` skipAttempt）不符，lockfile 釘 5.79.2 現無害 | 改 `^5.79.2` |
| worker | WK-17 | `diagnoses` 只有 `{machineId,jobId,cached,result,createdAt}`，fake 誤留 production 時無法區分；fake 在 production 只 warn 與 chaos 的 opt-in 守衛不對稱 | 加 provider／model／promptVersion／usage／latencyMs／attempt；守衛收緊**待使用者決策** |
| worker | WK-19 | `no_context` 屬預期業務結果，卻 warn 一行＋failed handler 帶 stack 的 error（`main.ts:192-193`） | 業務終態改 warn、不帶 stack |
| worker | WK-20 | `isFirstAttempt` 看 `attemptsMade===0`，stalled 重派不遞增 → hit／miss 重複計 | 以 `SET NX` 的 jobId 標記判斷（併 AR-4） |
| worker | WK-21 | `shutdown` 無重入保護與總時限；SDK d.ts 寫 retry 預設 5 次但實作無 `retryOptions` 即不重試，我們依賴此隱含行為；SDK `text` getter 用 `console.warn` 繞過 pino | 明確傳 `{attempts:1}`＋測試；shutdown 併 API-12 |
| web | WEB-13（實測） | zod `allowsEval` 執行 `new Function("")` 觸發 CSP `script-src eval` 違規每次載入一次；`nginx.conf:111`「無 eval」不精確 | 首次 parse 前 `z.config({jitless:true})`，30 分 |
| web | WEB-15（實測） | `tailwind.config.ts:253` content 含 `*.test.ts`，dist 出現只存在測試反向斷言的 `.border-accent` | content 加 `!./src/**/*.test.ts`，10 分 |
| web | WEB-16（實測） | 首次 ping 在 open 後 15 s 才送，期間 RTT「—」、靜默斷線偵測上界 20 s | open／subscribed 時立即 ping，30 分 |
| web | WEB-17 | `copilot.store.ts` 每則 token 寫 reactive `jobs` 與無讀者的 `lastActivityAt`；`StreamingPanel.vue:31-39` 每則 token 寫 `scrollTop` 強制 layout | plain Map；token 高頻時 rAF 合併 |
| web | WEB-18 | `StreamingPanel` 的 `stickToBottom` 跨機台、跨任務沿用（變異 M15 存活） | `:key="jobId"` |
| web | WEB-19（實測） | `EventStrip.vue:96-98`、`MachineNodeCard.vue:86-88` 跟隨 locale 顯示「上午10:32:31」 | 固定 formatter 並寫進 design-spec |
| web | WEB-20／AR-A10 | `MAX_ATTEMPTS=3`（`CopilotDrawer.vue:58`）與 `attempts:3`（`jobs.service.ts:173`）各一份；Attempt 只由 `ai/token` 推進，stalled 重派期恆顯示 1/3 | contracts 常數化；`job/status` 加 `attempt`／`execution`（012-lite） |
| web | WEB-21 | a11y：sidebar 機台按鈕無 `aria-current`；卡片 `aria-pressed` 但再點不取消；`FleetHealth.vue:185-190` `dl>div` 內含 span 不合規；連線 chip `role=status` 內 RTT 每變動都在 live region | 逐項小修 |
| web | WEB-22 | 行動版關閉 sheet 連帶 `desktopPanelOpen=false`（`App.vue:56-59`） | 分開狀態 |
| web | WEB-23 | 同 TQ-14（web `main.test` 30 s 逾時） | 併 TQ-14 |
| web | WEB-9 補充 | 拖曳未處理 `pointercancel`；拖曳中卸載殘留 `select-none` | 小修 |
| contracts | CT-16（實測） | `.trim()`／`.refine` 在 JSON Schema 看不到，漂移測試抓不到 | 走訪 `_zod.def` 遇 custom／transform／pipe 即失敗，1 h |
| contracts | CT-17（實測） | `@__PURE__` 只消掉外層呼叫，dist 仍殘留 `system/connected`、`machine/data`、`CreateDiagnosisBodySchema` 片段；`ws-client.ts` 整檔被 `sideEffects:false` 移除證明拆模組有效 | 漂移測試用 schema 移獨立模組，效益 <1 kB |
| contracts | CT-18 | 文件一致性測試 3 個變異抓不到（README 新增「契約版本 1.1.0」寫法、CHANGELOG 1.2.0 小節清空、README「12 個 channel」改 11）；README:372「`system/*` 只做漂移比對」不實（web 會 `safeParse`）；CHANGELOG:139 RFC 4122 vs `http.ts:15` RFC 9562 | 30 分 |
| contracts | CT-19 | 憲章例外 (c) 低報：`WORKER_METRICS_PATTERN`、`ai-stream:` 前綴、Mongo collection 名與文件形狀在 api／worker 各一份 | 010-lite `infra.ts` 收斂；之前憲章與 ADR-002 §6.5 先補列 |
| contracts | CT-20 | 憲章例外 (b) 要求 HTTP 錯誤碼記錄在案，CHANGELOG 未記 413 與畸形 JSON 的 400（無 `issues`） | 文件 |
| contracts | CT-21（實測） | `packages/shared/dist/logging/{interval,level}.test.*` 為 9/27 舊產物，build 不清 dist；`api start:dev` 疊加輸出；Docker 不受影響 | build 前刪 dist，10 分 |
| contracts | CT-22 | `LogThrottle.hit` 用牆鐘，時鐘回撥時持續壓掉日誌 | `now < lastAt` 時重設基準 |
| infra | INF-15 | mutation 基準 72.0 在 gateway 三個 commit（`12dcdd5`、`620d4b6`、`f2d9cb0`）之前量；gateway 單檔 68.47、break 70 餘裕小，首跑 nightly 可能紅 | release 前重跑並更新基準；小腳本檢查單檔門檻 |
| infra | INF-16（推理） | README:666「運行 10 秒後重置失敗計數」不正確（`restartCount` 只在手動 start／up 歸零，10 秒只歸零退避），`on-failure:5` 累計、長跑 demo 累積 5 次即永久 exited；引擎或主機重啟後只有 redis／mongo（`unless-stopped`）回來、api／worker（優雅 exit 0）不回，形成半套 stack | 修 README、補「重開機後請重跑 `up`」；app 服務是否改 `unless-stopped` **待使用者決策** |
| infra | INF-17（實測） | `tests/e2e/README.md:10,24` `corepack pnpm test:e2e` 在 `pnpm` 不在 PATH 的環境會失敗（root script 內裸 `pnpm`，INF-10 同源）；README:18「有殘留才 `down -v`」與 `global-setup.ts:27-30` 無條件執行不符；指南 :283 與 README:535 矛盾 | 改 `corepack pnpm --filter @flow-gatekeeper/e2e test:e2e`；`dev-up.ps1` 改用 `corepack pnpm`，15 分 |
| infra | INF-18 | README:556,563 直接 `./scripts/*.ps1`；新 Windows 預設 ExecutionPolicy Restricted 會被擋 | `powershell -ExecutionPolicy Bypass -File …` |
| infra | INF-19（實測） | Stryker 帶進 `qs` moderate ×3（`@stryker-mutator/core>typed-rest-client>qs`），`audit --prod` 為 0 | override `qs` `^6.16.0`；可與 INF-12 一起 |
| infra | INF-20 | `.dockerignore` 未排除 `tests/`、`reports/`（1.7 MB）、`.stryker-tmp/`、`docker-compose.*.yml`、root 測試／lint 設定 | 只影響 build context |
| infra | INF-21 | Dockerfile:26-32 註解「缺任一 importer 就 frozen 失敗」不精確（缺 `tests/e2e` 實測仍成功）；worker Dockerfile:63「未實測」可更新 | 修註解 |
| 測試 | TQ-21（實測） | worker `context-builder.ts:41-121` 覆蓋 12.5%，以 `as {state?}` 讀 api `history.service.ts:73-80` 寫入的文件；api 改欄位名時 `latestState` 靜默 "unknown"、cache signature 塌縮；只有 e2e 間接覆蓋 | 真 Mongo 整合測試補一支，或文件型別進 shared（併 CT-8／010-lite），1–2 h |
| 測試 | TQ-22 | TopologyCanvas、TopBar、AppLayout、FleetHealth、EventStrip、BackpressureBadge 0%，App.vue 1.7%，`health.service.ts` 4.3%，`gemini-provider.ts` 45.8% | 只補 TopBar、FleetHealth mount 各一支（併 WEB-24），2 h |
| 測試 | TQ-23（實測） | `apps/web/postcss.config.js` `tailwindcss: {}` 依 cwd 找設定，root 跑時「content option missing」、web 以空設定編 CSS | 改絕對路徑，5 分 |
| 測試 | TQ-24 | 存活變異 P3（60 里程碑位置；e2e 會抓但 e2e 不在 CI）、R5（`DELAYED_GRACE_MS` 無測試） | 補兩支 fake-timer，1 h |
| 測試 | TQ-25 | `test-support/nest-logger.ts:11-15` 以 `Reflect` 讀 Nest 私有 `staticInstanceRef`，改名時靜默寫回 undefined | 先 `Reflect.has` 不存在即 throw |
| 測試 | TQ-26 | Stryker 存活中 log 的 StringLiteral／ObjectLiteral 佔比大（processor 約 30/63、gateway 51/105），稀釋分數也掩蓋行為缺口 | ignorers 或 `// Stryker disable` 排除 logger 後重定基線，1 h |
| 架構 | AR-7（實測 B） | `commandTimeout` 逾時不等於取消：命令仍在 socket、Redis 恢復時照樣執行（17 則「publish 失敗」的 token 事後全部送達）；`tryAcquireLock` 逾時時鎖可能在恢復後被取得卻無人持有；`ai-rpm` 可能重複計數；log 措辭誤導 | 同 lockToken 補償性 compare-and-del；改寫 log，0.5 人日 |
| 架構 | AR-8（實測 A） | api 冷啟動 10–17 s（`@nestjs/core` 2.8 s、bullmq 2.5 s、mongodb 1.4 s、app.module 3.1 s），期間 nginx 502 | README 寫 MTTR；Node 24 時評估 compile cache |
| 架構 | AR-A11（推理） | `context-builder` 以 worker `Date.now()` 查 api 以 api 時鐘寫入的時間戳，多主機偏差時時間窗變空、誤判 `no_context` | Mongo `$$NOW` 或寫明需 NTP |
| 架構 | AR-A13 | Batch B 讓 `POST /diagnoses` 與 WS 硬綁同一實例（`jobs.service.ts:103-111`），否則 409；ADR-002 §6.1 缺連線配額與 mock telemetry producer 兩處單實例狀態 | 只改文件 |
| 架構 | AR-S8（推理） | 背壓可丟 `ai/token`，reducer 以 `seq===0` 判換輪；seq 0 剛好被丟時舊輪文字與新輪拼接 | 改記 `lastSeq`、以 `seq<=lastSeq` 判換輪，0.1 人日 |
| 文件 | DOC-22 | 指南 :2630 把 006 標「初步規劃（尚未 specify）」，實已 07-04 併入 `c0602d6`；001–005 章無狀態標記 | 文件 |
| 文件 | DOC-23 | README 覆蓋率 81.4／76.4、976 支 vs 指南 :3337 與 C.8 的 81.52／76.56、982 支 | 對齊（本輪隔離重跑 982、81.52／76.56） |
| 文件 | DOC-24 | README 與指南 §15.5「012」與「012-lite」混用 | 統一 |
| 文件 | DOC-25 | 指南 :3288 把升 1.2.0 寫在 `898ccfc` 段，實際為 `ef5d494`；`git show 898ccfc:asyncapi.yaml` 仍 1.1.0，Batch A／B 改 asyncapi 未升版 | 更正 |
| 文件 | DOC-26 | 008 無「已變更」橫幅；plan／data-model 仍寫 `8080:80`、`nginx:alpine`、NestJS 10／Vite 5；`quickstart.md:209` 教改 `9090:80` 現會連不上 | 補橫幅與更正 |
| 文件 | DOC-27 | ADR-001「自管代價」表 :71-78 沒有 Batch B 內容（背壓、nonce 心跳、違規計數、連線上限、授權期限） | 補表 |
| 文件 | DOC-28 | 契約 1.2.0 小節漏三項連線層義務：grace 內未授權 1008、違規 10 次 1008、滿載 upgrade 503 | 補 CHANGELOG |
| 文件 | DOC-29 | `asyncapi.yaml:47` `job/status`「optionally carrying the final result」但欄位從未被填 | 012-lite 落地前改措辭或標「保留」 |
| 文件 | DOC-30 | 版本策略權威三方互指：憲章 :286→CLAUDE.md→CHANGELOG→CLAUDE.md | 單一來源指向 CHANGELOG |
| 文件 | DOC-31 | 憲章 1.5.0 移除 MAY（收緊）卻以 MINOR 處理，Sync Impact Report 無判準 | 補判準 |
| 文件 | DOC-32 | 小誤差：RFC 4122／9562 寫法不一；fake provider 逾時警告公式文件與實作不一致（實作 `min(FAKE_AI_TOKENS, 文字長度)−1`）；根 `.env.example` 新增變數清單漏 `WORKER_INSTANCE_ID` 與 `WORKER_CHAOS*`；README 未說 `WORKER_CHAOS_AT` 非法值會關閉整個 chaos | 文件 |
| 文件 | DOC-33 | 第二輪「DOC-9～D15」範圍寫法可能撞號 | 本文已聲明 DOC-12+ 指第三輪 |
| 文件 | DOC-34 | 009 spec Status 缺「之後變更見 §15.6」（001–008 都有） | 補一行 |
| 文件 | DOC-35 | Agent memory 筆記過時（第二輪「尚未修復」、INF-6 分歧、領先 36 commit、17 commit 實為 16） | 收尾時更新（非真實來源） |

---

## 5. 架構層結論

### 5.1 狀態所在地：api 行程內單實例狀態 10 → 15 處

Batch B 新增授權集合（`authorized`＋`unauthorizedCount`）、違規計數、closeTimer、背壓計數（`overHighWaterTicks`／`droppedSends`）、連線配額五處；第二輪漏列 mock telemetry producer（`mock-telemetry.service.ts:15`、`monitoring.gateway.ts:178-181,438-452`）——多實例時會產生 N 條互不一致的假資料流並落庫 N 倍，是最早出問題的一處。多實例後果最具體的是 AR-A13：`POST /diagnoses` 的 `isAuthorized` 只查本實例，打到別台就 409。ADR-002 §6.1 已含授權集合到背壓五處，**缺連線配額與 mock producer**，建議補入。隱性耦合較第二輪新增：`ai-stream:` 前綴與 `WORKER_METRICS_PATTERN` 在 api／worker 各一份（CT-19）、attempts 常數前後端各一份（WEB-20／AR-A10）、context 時間窗跨時鐘（AR-A11）、`TopologyCanvas.vue:4` 新增 domain→domain 匯入 ai-copilot。

### 5.2 FMEA 現況（第二輪八列逐項更新）

| 情境 | 第二輪判定 | 本輪現況 |
| --- | --- | --- |
| 持鎖 worker 被 SIGKILL | 未處理 | 未變。e2e 實測 92 s 無事件；等待者也要等 lock TTL 45 s。根因是 BullMQ 預設參數（AR-S7） |
| LLM 成功後 Redis 瞬斷 | 未處理（WK-4） | 未變，但語意補充：**停頓型（pause）不會重打 LLM**——processor 卡在 `updateProgress(80)`（BullMQ 連線無 commandTimeout），恢復後續跑（實測 B、C）；停頓超過 30 s 則**雙重執行**（AR-4）。寫庫失敗型仍重打 LLM 且不送 `ai/error`（WK-4 補強） |
| `ai/done` Pub/Sub 遺失（api 重啟瞬間） | 未處理（AR-1） | **語意更正**：api 重啟必斷 WS，web 重連後立即標「連線中斷」、Retry 命中快取不重打 LLM（實測 A）。api 冷啟動 10–17 s 期間 nginx 502（AR-8） |
| **新增：WS 沒斷、Pub/Sub 斷** | — | 收到 `completed` 但無 `ai/done`，45 s 後判逾時；api 全程 0 日誌（實測 D2；AR-5／AR-6／WK-14） |
| 前端重連換 clientId | 部分 | 部分改善：斷線期間 `POST` 會 409、`isLive` 閘門統一；rebind 仍未做（012-lite） |
| Mongo 斷線 | 語意錯誤（AR-A9） | 未變；新增 AR-A12：cache 命中路徑先宣告成功後寫稽核，前後端終態不一致 |
| Redis `noeviction` 滿 | 部分（API-3） | 濫用路徑已封：名冊外 machineId 回 404 |
| Gemini 429 | 可改善 | 未變（仍消耗 attempts） |
| 慢讀者 WS client | 未處理（API-2） | 已修（高水位＋連續 3 tick terminate、nonce pong）；**新增入站放大口**（API-13） |

**逾時鏈**：預設 AI 30 s、鎖 45 s、watchdog 45 s、keepalive 15 s。超過 45 s 沒有事件的只有四種情況：持鎖者被 SIGKILL、本 job 的 worker 被 SIGKILL（約 92 s）、Redis 停頓超過 45 s、Pub/Sub 斷線；另 `AI_TIMEOUT_MS` 設到 45 s 以上也會觸發且目前沒有執行期驗證。

### 5.3 模組邊界

- **已做**：`useDiagnoseTrigger` 單一入口（App、TopBar、TopologyCanvas 三處）；shared logging 收斂（`LogThrottle`／`ConnectionErrorThrottle`／`redact`）。
- **未做**：Gateway 拆分（現 554～597 行、Stryker 68.47）、`JobRoutingRegistry`、thresholds 移進 contracts、`src/app/` 殼層與 eslint 邊界規則；`main.ts:45-66` 仍以 `app.get()` 手動接線。
- **建議修訂**：Gateway 只拆兩刀——先拆 `WsConnectionRegistry`（授權、心跳、closeTimer、違規與速率、背壓 deliver；mutation 分數最低、本輪問題集中處；約 0.5 人日、不改 wire format），`JobRoutingRegistry` 隨 012-lite 抽出（rebind 就寫在它裡面）。Subscription／TelemetryPipeline 延後。另收一個有時限的 ShutdownCoordinator（API-12／WK-21）。`packages/shared` 不必拆包：在 `./logging` export 加 `"browser": null` 條件取代 eslint 防線（需實測 Vite 行為）。

### 5.4 Roadmap 修訂：quick-fix → 012-lite → 010-lite（縮小）→ 011

| # | 範圍 | 為何調整 |
| --- | --- | --- |
| **quick-fix**（約 1 人日，獨立 `fix/` 分支） | API-1（P1）＋CT-13＋API-11；AR-5／WK-14 終態 await publish＋relay 10 s 寬限；AR-6 web 2 s 收尾＋api 訂閱轉態日誌；AR-A12 先落地後宣告；AR-S8 `lastSeq`；API-13 pong 受背壓＋入站 token bucket；API-12 關閉總時限；TQ-14／15／16 | 全部是小修、彼此獨立、可立即降低「後端成功、畫面失敗」與祕密外洩的機率，且不需等 feature 立案 |
| **012-lite** 串流韌性 | processor 回傳結果作 `returnvalue`；開頭以 jobId 查 `diagnoses`、trigger 冪等、hit／miss 去重（AR-4／WK-4／WK-20）；`ai-fail:<sig>` 負向標記（WK-13）；等待者與首 token 前每 10 s keepalive；BullMQ lock 15 s／stalled 10 s／maxStalled 2（AR-S7）；relay 的 `completed` 從 `returnvalue` 經驗證填 `job/status.result`；監聽 `stalled` 下發 `waiting`＋`reason:"stalled"`；抽出 `JobRoutingRegistry`；`GET /diagnoses/:jobId?socketId=`（沿用 POST 授權閘門；`Job.fromId`→Mongo→404；只有原綁定者已離線才允許 rebind）；web `completed` 帶 result 即收尾、`onReconnect` 先 GET、Attempt 改用 `job/status.attempt`。契約 asyncapi 1.3.0（`job/status` 加 optional `attempt`／`execution`／`reason`；`ai/done` 降為可重複的 best-effort 訊號；`http.ts` 新增 `DiagnosisLookupResponse`）；需 ADR-003。估 4–5 人日 | 使用者看得到的問題全在這裡；WS 契約 additive、`returnvalue` 由 QueueEvents 零成本取得；`JobRoutingRegistry` 本是 rebind 載體。驗收 e2e：SIGKILL 最長無事件 <45 s；Pub/Sub kill loop 以 `result` 完成；api 重啟後以 GET／rebind 完成；Redis pause 50 s 後 trigger 只一筆、LLM 只一次；GET 404／409；reducer 三種事件順序收斂同一狀態 |
| **010-lite** 資料層單一來源（縮小） | `contracts/src/infra.ts`（channel、key builder、`COLLECTIONS`、`DIAGNOSIS_JOB_OPTIONS`、`STALL_TIMEOUT_MS`；放子路徑 `contracts/infra`）；`DiagnosisJobPayloadSchema` worker 消費時 `safeParse`（CT-8）；`AiErrorCode`（AR-A9）——**在 wire 上保持開放**（封閉 enum 會讓舊版 web 把帶新 code 的 `ai/error` 整則丟棄），producer 端以 `satisfies` 約束，web `humanizeError` 改依 code 對照；`WorkerMetrics.windowMs`；`system/connected` 加 optional `protocolVersion` 與 `stallTimeoutMs`；worker 以 `superRefine` 驗 `AI_TIMEOUT_MS ≤ 45 s − 10 s`；可選 asyncapi 由 Zod 產生（ADR-004）。**移除**「名冊下發」（名冊已單一來源 `contracts/src/machines.ts`）與 `JobRoutingRegistry`（已入 012-lite）。契約 1.4.0。估 3 人日（＋1 若做 asyncapi 產生） | 等 012-lite 定案後一次升版，避免契約升兩次；驗收：apps 下 key 字串零命中、漂移測試過、`AI_TIMEOUT_MS=40000` 啟動即 fatal、每錯誤碼有文案 |
| **011** 效能證據自動化 | `system/metrics` 加 optional `ws:{droppedSends, pubsubReconnects}`；WEB-12 badge 重定義（web 分開計數 WS 訊息數與點數）；`VITE_PERF` 下曝露 `window.__fgPerf`；headless 瀏覽器在 50／20／10 ms 三段頻率量 fps／long task／heap 輸出 JSON 設門檻；bundle 預算並以數據決定 `zod/mini`。本輪的假 Gateway＋Playwright 探針可直接演進成 harness。契約 1.5.0。估 3–4 人日 | 需先有 012-lite 的完成語意（否則量測被 watchdog 汙染）與 API-13 修復（否則指標被入站流量汙染） |

### 5.5 技術棧選型（全部維持，不換任何核心元件）

| 分類 | 項目 | 一句理由 |
| --- | --- | --- |
| 維持 | NestJS 11、Express 5、原生 ws 8（ADR-001 成立）、BullMQ 5（012-lite 調參，先用完 `returnvalue`／`stalled`）、Redis Pub/Sub（降為動畫通道）、ioredis 5、Mongo time-series、Pinia 3、Zod 4 classic（後端）、Vite 7、vitest 4、pnpm 10、pino 9、dotenv 16（不升 17） | 皆為各自 major 最新線；本輪問題沒有一項需要換元件才能解 |
| 維持但釘版 | `@google/genai` 2.24.0（已是最新） | 改 `~` 釘 minor；SDK 隱含「無 retryOptions 即不重試」行為要明確傳 `{attempts:1}`（WK-21） |
| 不要動 | Tailwind 4（CSS-first 需全面遷移 token，WEB-1 已證明視覺回歸風險）、TS 6／7（6 為過渡版，7 等 vue-tsc 與 typescript-eslint） | 收益低風險高 |
| 不需要 | BullMQ Pro／Flows | 單一 job 型態用不到 |
| 不要做（定案） | 自行實作 Redis Streams（012 原案） | QueueEvents 本身就是 Stream 且已帶 `returnvalue`；ADR-002 §6.2「生產路徑：Streams」在 012-lite 落地時應改寫為「已拒絕」 |
| 延後 | `zod/mini`（約 −20 kB gzip）；先做 `jitless`（WEB-13） | 延到 011 以量測數據決定，須走 ADR；約 60 個表達式要改寫、收益只在 web |
| 下一個 upgrade 維護分支順手 | eslint 10（9 線 EOL）、`@lucide/vue`、Node 24 LTS（Node 22 於 2027-04 EOL；`.nvmrc` 釘死解 INF-13）、ioredis `dedupe`（INF-7）、bullmq 下限 `^5.79.2`（WK-16）、`qs` override（INF-19）；BullMQ 6.3.9 與 mongodb 7.6.0 已發布，另評估 | 不需 ADR，但要回補 README、Dockerfile、engines。**注意**：Node 25 起不再內建 corepack，Dockerfile 與 README 的 `corepack enable` 到 Node 26 會失效，先在 ADR-002 §6.5.1 記一列 |
| 契約產生方向 | asyncapi 由 Zod 產生（registry id 加 `uri` 對映 `components/schemas`，後處理剝 date-time pattern 與安全整數上下限，channels 留手寫 base yaml，description 改 `.meta`） | 已實測輸出形狀可行、約 1 天；建議先做 CT-14／CT-15 把閘門補齊再談產生 |

### 5.6 ADR

- ADR-001 成立。ADR-002 §7 拒絕路線全部成立（AR-4／AR-7 靠冪等解決，不需要 HA）；§9 四條推翻條件均未逼近；AR-A13 讓「需要第二實例」時的代價更具體，建議寫入 §6.1。
- **建議新增 ADR-003「診斷完成語意與結果讀取」**：終態以 BullMQ state／`returnvalue` 為準、`ai/done` 可重複、Pub/Sub 維持 at-most-once、拒絕 Streams、rebind 授權模型（jobId 即 bearer capability）、lock 參數、逾時語意為「結果未知」。
- 可選 ADR-004「asyncapi 由 Zod 產生」。

---

## 6. 建議處理順序

### Batch E：quick-fix（獨立 `fix/` 分支，約 1 人日，release 前必做）

1. **API-1**（P1）producer Queue 掛 `attachThrottledErrorLog`＋單測；worker Queue／FlowProducer 比照。
2. CT-13 `formatters.log` 全深度 `stripCommandArgs`＋API-11 adapter Error 導到 `err` 鍵＋全域 ExceptionFilter（合修 API-7／API-17）＋回歸測試。
3. AR-5／WK-14 終態 `await publish`＋relay 終態後綁定保留 10 s；AR-6 api 訂閱 `close`／`reconnecting` 日誌＋web `completed` 後 2 s 無 `ai/done` 即收尾；AR-A12 cache 命中路徑先落地後宣告；AR-S8 `lastSeq`。
4. API-13 pong 受高水位＋每連線 token bucket；API-12／WK-21 `app.close()`／worker shutdown 總時限與重入保護。
5. TQ-14 三支 `main.test` 改檔頂 import；TQ-15 `reportsDirectory` 環境變數；TQ-16 `toHaveBeenCalled`；TQ-17 兩支重試測試；TQ-20 門檻 ratchet 78／73＋核心檔下限。
6. WEB-4 補強、WEB-13 `jitless`、WEB-15、WEB-16；WK-19 業務終態 warn。

### Batch F：文件與 release 閘門（Batch E 之後、v1.1.0 之前）

1. DOC-12 三處填 `4c43d18`＋CLAUDE.md SPECKIT 區塊；DOC-13 改以分支名為鍵並寫進維護分支小節；DOC-19 release 第 4 步措辭。
2. DOC-14 CHANGELOG 相容性注意補五類；DOC-28 補三項連線層義務；CT-20 補 413／400；DOC-15 宣告公開介面並定義「相容」（**版號待使用者決策**）。
3. DOC-17／WK-18 ADR-002 §6.5.1 補齊孤兒（首輪 §3.1 a／c／d／f、§3.2 a；C.9 #12／#13 標遺失；push 待辦；SDD 精簡）；ADR-002 §6.1 補連線配額與 mock producer；ADR-001 自管代價表補 Batch B（DOC-27）。
4. DOC-16 指南新增 010-lite 藍圖（採本輪 §5.4 縮小版）＋012-lite 藍圖；DOC-29 `job/status.result` 措辭。
5. **單一來源化**（DOC-20）：backlog 以 ADR-002 §6.5.1 為唯一來源（或改用 GitHub Issues，repo 已公開，可用 `speckit-taskstoissues`），審查報告只放連結；變更紀錄只留 `CHANGELOG.md`，指南 §15.6 縮成索引表；第三輪起報告只寫發現與結論，修復完成度以 backlog 關閉追蹤。
6. DOC-18（**待使用者決策**）決定後回補 ADR-002 :52／:217、指南 :1024、兩個 workflow 註解；INF-14 nightly 改每週或 develop 有變更才跑、`--incremental`；INF-15 重跑 mutation 更新基準。
7. Low 文件項：DOC-22～26、DOC-30～34、INF-16／17／18／21、CT-18、CT-21。
8. release 第 1 步補兩項：`[Unreleased]` 內不得有「待…」佔位字樣；附上 `test:integration` 與 `test:e2e` 的本機實跑紀錄。CT-15 契約 fingerprint 測試作為自動閘門。

### Batch G：測試基礎建設補強（可穿插，約 1.5 天）

TQ-18 Gateway 關閉路徑 3 支（拉到 72～75）→ TQ-24 P3／R5 兩支 fake-timer → TQ-26 Stryker 排除 log 字串後重定基線、break 改逐檔判定 → WEB-24 App 接線層整合測試（併 TQ-22 TopBar／FleetHealth）→ TQ-21 跨 process 形狀整合測試（作為 010-lite 樣板）→ CI 加 redis／mongo services 跑 `test:integration`（<15 s）、e2e 併 nightly → CT-14 channels 斷言、CT-16 refine／transform 偵測。

### upgrade 維護分支（獨立，不急）

eslint 10、`@lucide/vue`、Node 24 LTS＋`.nvmrc` 釘死、ioredis `dedupe`、bullmq 下限、`qs` override、`@google/genai` 改 `~`；評估 BullMQ 6／mongodb 7。回補 README、Dockerfile、engines、ADR-002 §6.5.1（corepack 於 Node 25+ 移除）。

### Roadmap：012-lite → 010-lite（縮小）→ 011（見 §5.4），依 SDD 流程另開 feature；012-lite 立案前先寫 ADR-003。

---

## 7. 不必做的事

前兩輪 §6／§7 全部維持。本輪新增或定案：

- **不要自行實作 Redis Streams**（定案）：QueueEvents 本身就是 Stream 且帶 `returnvalue`。
- **不要為 AR-4／AR-7 引入 HA 或多 worker 協調**：冪等（jobId 查 `diagnoses`、trigger 冪等寫入）就夠。
- **不要為 API-13 引入 rate-limit 中介層或 Socket.IO**：每連線 token bucket＋pong 受背壓即可。
- **不要把 `main.test` 的重依賴 mock 掉或移到 e2e**：檔頂靜態 import 就解決 flaky，且保留「import 就炸」的偵測價值。
- **不要為 CT-17 的 <1 kB 殘留重構契約模組**：留到 011 以 bundle 預算數據決定。
- **不要現在做 `zod/mini`、Tailwind 4、TS 7**。
- **不要一次補完 TQ-22 的所有 0% 元件**：只補 TopBar、FleetHealth 與 App 接線層。
- **不要為 INF-20 的 build context 大小重整 `.dockerignore` 以外的東西**：Dockerfile 用明確 COPY，不進 image。
- **不要為了恢復 CI 而先重寫 workflow**：先 push 並手動 `workflow_dispatch` 一次取得 2 vCPU／4 vCPU 基線，再決定 timeout 與觸發策略。

---

## 8. 通過驛證、無問題的項目

- **api**：POST 狀態碼與 README 一致（415／400／404／409／201／冪等 201／409／413）；Redis 認證失敗 5.9 s 回 503、`/healthz` 76 ms 回 503 並逐項列依賴；JobsService 併發重送共用 enqueuing promise、失敗解除綁定、409 warn 節流；AiStreamRelay 轉發前 schema 驗證並比對 jobId；JobStatusRelay keepalive、失敗順序、孤兒回收正確、各 Map 有上限；Gateway Map 與計時器生命週期對稱（cleanup 冪等、清 closeTimer、`unauthorizedCount` 增減對稱、LogThrottle key 有界）；`safeEqual`（SHA-256 後 `timingSafeEqual`）與 Origin 檢查正確；`maxPayload` 16 KiB、未開 deflate；env fail-fast 不回顯祕密；未開 CORS 搭配 415 形成 CSRF 防線。
- **worker**：cache→鎖→double-check→限流→LLM 順序與 Lua 原子性；abort 經 SDK 傳到 fetch、`abortable` 無 listener 洩漏、逾時後 token 閘門（實測）；seq 與 attempt 語意；非最終失敗不送 `ai/error`（實測 4 次）、終態才送（2 次）；兩道 schema 驗證；Gemini 錯誤分類 400／401／403／404 不重試；thought parts 排除；fake provider 簽章獨立、輸出過 schema、可 abort、逾時 warn 正確；chaos 守衛、fatal、env、instanceId、heartbeat／liveness、metrics 環形緩衝；index 退回路徑 8 支 Mongo 整合測試；closing 時交回佇列與 `stop_grace_period 45s` 相容。
- **web**：連線三態單一來源；`retireSocket` 防疊重連；背景分頁 timer flush、`online` 立即重連；`classifyWsMessage` 是完整信任邊界；copilot store 先建狀態再 POST、inFlight 去重、只在同 job 回滾、`ai/done` 二次驗證、45 s watchdog；`postDiagnose` 逾時、錯誤碼中文、回應 schema 驗證、jobId 一致性；行動版 dialog 焦點陷阱與觸控 icon 常駐（實測）；reduced-motion 與 variants 順序；design-spec token 零漂移、無未定義 class；硬規則 1（遙測非 reactive buffer、`shallowRef`＋`triggerRef` 一批一次）守住；事件上限 50、buffer 2000 並合併、AbortController 一次解除 listener、keydown／document listener／observer 對稱清理；CSP 除 WEB-13 外無違規。
- **contracts／shared**：`WS_MESSAGE_TYPES` 雙向綁定；asyncapi publish／subscribe 語意與 draft-07 寫法；`io:"input"` 搭配 strip 向後相容；zod 全 workspace 單一 4.6.5；ESM、`development` condition、`files:["dist"]`、`sideEffects:false` 生效；shared 根 export 不帶 logging、web bundle 無 pino；`ConnectionErrorThrottle` 轉態語意；`deriveMachineState` 單一來源；`DIAGNOSIS_RESULT_JSON_SCHEMA` 快照保護；CHANGELOG 契約 1.1.0／1.2.0 兩節與 diff 逐項對得上。
- **infra**：三種 compose 組合 `config -q`、e2e override 合併（`!reset` ports、18080、fake provider、`:e2e` tag、`start_interval`）、project 隔離（`-p flow-gatekeeper-e2e`，volume／network 帶前綴，`down -v` 不碰 demo）、乾淨 clone 模擬；四個 base image digest 與 Docker Hub 一致；`audit --prod` 0；worker legacy deploy 產物與 lockfile 一致、不含 dev 依賴；redis 由 entrypoint 降權、探針 `REDISCLI_AUTH`、`noeviction` 搭 384m 上限；infra 服務綁 127.0.0.1、api 不對外開埠；所有服務有 log 輪替與 cpu／memory 上限；api／worker `USER node`、web nginx-unprivileged；nginx resolver 延後解析、CSP 三處一致、`server_tokens off`、快取策略；CI permissions／concurrency／timeout／`.nvmrc`／coverage 上傳路徑；`packageManager` 帶 sha512。
- **測試與品質**：整合 27/27 且隔離良好；production 0 處 `any`／`eslint-disable`／`@ts-*`／`as unknown as`／TODO；`!` 只剩已知兩處；`switch-exhaustiveness-check` 試開 0 命中；fake timers 與 `stubEnv` 皆還原；死碼只剩已知兩處；54/57 手工變異被殺；e2e 五場景斷言精確；web 元件測試有斷言力。
- **文件與 git 流程**：2026-09-27 之後 5 個 merge 皆 `--no-ff` 且訊息合規、38 個 commit 格式合規（regex 掃 0 例外）、維護分支命名合規；specs 001–008 Status 的 hash 與日期正確、14 份橫幅在；憲章 1.5.0 三項例外與程式碼一致、Governance 與 CLAUDE.md 對齊；README 26 種指令皆存在、env 表逐鍵一致、版本需求與 CHANGELOG／compose 一致、回應碼與 `http.ts` 一致；demo 影片確在 v1.0.0 release 附檔；文件一致性測試設計良好（防假綠、雙向、例外過期檢查）；design-spec 移轉橫幅正確（canonical v0.6）。

---

## 附錄 A：審查方法、產物與對環境的副作用

- **分工**：8 個 Opus 5.5 agent 各自唯讀審查一個面向，要求「先逐項驗證附錄 C 的修復宣稱 → 找新問題 → 給優化方向」，每項 finding 附 `file:line`、嚴重度與分類，關鍵項實測。統籌者（Fable 5.1）另行實跑全套檢查、對每份報告的 P1／P2 抽查原始碼或探測 log（API-1 的 Queue listener 與 bullmq `console.error` 路徑、`processor.ts:98` 的 `void publish`、worker `Worker` 選項、README:666、e2e README 與 `global-setup`、`gh repo view` 可見性、`pnpm audit`、CI 觸發與 `main` 上的 workflow 檔），對同一問題由多個 agent 獨立發現者提升信心（祕密衛生：api／contracts；完成語意：worker／架構／api；CI 從未跑：docs／infra／tests）。
- **實測項目**：真實 NestJS 11 app（dist 組合根）＋ws client／原始 TCP 五支探測；假 Redis `WRONGPASS` 重現密碼外洩（api／contracts 各自）；真 BullMQ＋fake provider 六個 worker 場景（含 Mongo validator 寫庫失敗、同簽章逾時）；拋棄式 compose project `fg-r03-arch` 四個故障情境（api 優雅重啟、Redis pause 20 s／50 s、`CLIENT KILL TYPE pubsub` 每 50 ms × 45 s）並記錄三端事件時序；headless Chromium 讀卡片 computed style、假 Gateway 黑洞模式、CSP 監聽；57 個記憶體內手工變異（processor／gateway／relay／composable／reducer／history／metrics.store／pino）＋web 20 個＋contracts 21 個；`test:coverage` 隔離重跑；e2e 一次；Stryker 單檔 ×2；worker 單元連跑 8 次；模擬 Docker builder 條件的 frozen install＋`deploy --legacy`；Docker Hub API 比對 digest；三種 compose 組合 `config -q`；`z.toJSONSchema` 輸出形狀探測；web bundle 殘留檢查。
- **未實測、屬推理**：AR-5 的跨連線競態（依 Redis／libuv 語意）；AR-S7 改參數後的 35 s 上界；INF-16 restart 計數（依 moby restartmanager 語意）；Docker image `build`／`history`／`inspect`（infra agent 執行時引擎未啟動；補做指令見 scratchpad `review03/infra/report.md`）；Mongo 斷線、Gemini 429、時鐘偏移、多 api 實例。
- **產物位置**（未納入 repo）：統籌者 scratchpad `review03/` 下八份面向報告、`checks/full.log`（並行實跑）與 `checks/coverage-quiet.log`（隔離重跑）、`coordinator-notes.md`、api 五支探測腳本與 result JSON／log、worker `driver.mts` 與各場景 log、web `fake-server.cjs`／`probe.cjs`／截圖／變異結果、contracts `redact-live`／`nest-adapter-leak`／`mutate.sh`／`mutation-results.txt`、infra `cmp.cjs`／`e2e-config.yml`、tests-quality `cov2/`／`mut/results.tsv`／`stryker-*.json`／`e2e-run.txt`／`worker-rep-*.txt`、architecture `observer.mjs`／`compose.override.yml`／`killpubsub.sh`／`exp{A,B,C,D,D2}.log`。
- **對環境的副作用**：repo 無任何 tracked 檔案修改、無 git 寫入；重建了 gitignored 的 `packages/*/dist`、`apps/*/dist`、`coverage/`（`reports/mutation` 已備份還原並以 `cmp` 驗證一致）。審查期間 Docker Desktop 由架構 agent 啟動，附帶讓使用者 dev 用的 `flow-gatekeeper-redis-1`／`mongo-1`（`unless-stopped`）自動拉起；worker agent 另執行過 `docker compose up -d`。**收尾時依使用者指示** `docker compose down` 移除該 project 的容器與網路（兩個具名 volume `flow-gatekeeper_{redis,mongo}-data` 保留），刪除 api agent 拉的 `redis:7-alpine`／`mongo:7` 映像；所有拋棄式容器（`r03api-*`、`review03-worker-*`、`fg-r03-arch`、`flow-gatekeeper-e2e`）與 volume 皆已清除，`:e2e` 三個映像保留。worker agent 的探針在 repo 根目錄留下未追蹤的 `worker1.pid`，已由統籌者刪除，`git status` 乾淨。

## 附錄 B：與前輪報告的對照

| 前輪（review02）結論 | 本輪判定 |
| --- | --- |
| C.2「CT-1／API-1 已修」 | **部分**：pino 路徑已遮蔽；producer Queue 的 `console.error` 路徑外洩（API-1，P1）；redact 有巢狀／陣列旁路（CT-13）；adapter stringify（API-11） |
| §5.2「api 重啟時 `ai/done` 遺失 → 前端卡 45 s」 | **不成立**（實測 A）：api 重啟必斷 WS，web 立即標「連線中斷」、Retry 命中快取。改為「WS 沒斷、Pub/Sub 斷」一列（實測 D2） |
| §5.2「LLM 成功後 Redis 瞬斷 → 重打 LLM」 | 補強：停頓型不重打（實測 B／C）；停頓 >30 s 雙重執行（AR-4）；寫庫失敗型重打且不送 `ai/error`（WK-4 補強） |
| §5.1「api 行程內 10 處單實例狀態」 | 更正為 **15 處**（Batch B 新增 5、漏列 mock telemetry producer） |
| §5.4 roadmap 010-lite→012-lite→011 | 修訂為 **quick-fix→012-lite→010-lite（縄小）→011**；`JobRoutingRegistry` 移入 012-lite；010-lite 拿掉名冊下發；`AiErrorCode` 在 wire 上保持開放 |
| §5.5「Redis Streams 先不做」 | **定案不做**：QueueEvents 本身是 Stream 且帶 `returnvalue` |
| C.8「覆蓋率 81.52／76.56」 | 屬實（隔離重跑逐位一致）；但並行跑會被污染到 71.9／67.3 且仍過門檻（TQ-15） |
| C.8「worker 曾出現 1 支偶發失敗，建議另查」 | 已定位：`main.test` 的 import timeout（TQ-14），8/8 連跑綠、兩次高負載失敗皆為該支 |
| C.7「Stryker 單檔低於 70（gateway 66.5、processor 62.7）」 | processor 已升至 73.86；gateway 68.47 仍低於 70，主因是關閉路徑零斷言（TQ-18） |
| C.9「nightly 180 分為推估值」 | 補充：1128 個 mutant、私有 2 vCPU 估 115～130 分；但 repo 為 PUBLIC（4 vCPU、不計分鐘），推估基礎本身要重算（INF-14／DOC-18） |
| §8「git 流程合規」 | 成立，但 CI 從未在 GitHub 跑過（78 commit 未 push、nightly 不在 main） |
| 附錄 C 判定「116 列已修 72／部分 7／後續 37」 | 已修 72 列全部核實成立（CT-1 改判部分）；後續 37 列現況與 ADR-002 §6.5／§6.5.1 一致，但 backlog 另有孤兒（DOC-17／WK-18） |

## 附錄 C：留待使用者決策

| 項目 | 選項 | 影響 |
| --- | --- | --- |
| DOC-18 是否恢復 CI 自動觸發 | (a) 恢復 `pull_request`（加 `paths-ignore`）、不恢復 push；(b) 維持手動 | repo 已 PUBLIC 不計分鐘；決定後回補 ADR-002、指南、workflow 註解 |
| DOC-15 v1.1.0 版號 | (A，建議) 維持 1.1.0 並在 CHANGELOG 宣告公開介面與「相容」定義；(B) 改 2.0.0 | A 約 15 分；B 需改六份 `package.json` 與 CHANGELOG |
| `AI_PROVIDER=fake` 在 production | (a) 維持只 warn；(b) 改需顯式 opt-in 旗標（與 chaos 守衛對稱） | WK-17 另建議 `diagnoses` 加 provider 欄位讓假診斷可辨識 |
| INF-16 api／worker／web 的 restart policy | (a) 維持 `on-failure:5`（重開機後需手動 `up`）；(b) 改 `unless-stopped` | 屬 ADR-002 §4 監督者取捨 |
| Docker 兩個具名 volume | (a) 保留 `flow-gatekeeper_{redis,mongo}-data`；(b) 一併清除 | 內含 demo 歷史資料 |
| `@vitest/coverage-v8` 釘死 vs `vitest` caret | 下次 upgrade 分支統一 | C.9 #8 延續 |
