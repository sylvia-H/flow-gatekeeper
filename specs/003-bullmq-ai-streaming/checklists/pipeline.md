# Pipeline Requirements-Quality Checklist: 診斷任務佇列、AI 串流診斷與 Redis 快取

**Purpose**: 以「需求品質」為對象的 release gate——驗證 spec 對非同步／並發、失敗與復原、契約與
可追溯性、憲章紀律四面向的需求是否完整、清晰、一致、可驗證，而非驗證實作是否正確。
**Created**: 2026-07-01
**Feature**: [spec.md](../spec.md)

**Note**: 每一項都在問「需求本身寫得好不好」，不是問「系統跑不跑得對」。勾選代表該需求品質面向
已確認無虞；打叉／留白代表 spec 需補強後才進 `/speckit-tasks` 或 `/speckit-implement`。

## 非同步與並發正確性（Async & Concurrency）

- [ ] CHK001 是否明確定義速率上限的計量方式與範圍——「一分鐘內實際 LLM 呼叫」是否可無歧義地量測？[Clarity, Spec §FR-003, §SC-003]
- [ ] CHK002 「同一情境同時湧入多筆請求只有一筆真正呼叫 LLM」的「同一情境」是否以可判定的簽章組成定義？[Clarity, Spec §FR-006, §SC-004]
- [ ] CHK003 去重鎖的有效期與「持鎖者逾時後放行」的邊界是否量化（而非僅描述性）？[Measurability, Spec §FR-006]
- [ ] CHK004 快取簽章的組成欄位是否完整且無歧義地列出（機台／狀態／錯誤類型／promptVersion／model）？[Completeness, Spec §FR-005]
- [ ] CHK005 是否要求 `ai/token` 具可排序的遞增序號，且序號語意（起始值、連續性）有定義？[Completeness, Spec §FR-008]
- [ ] CHK006 job 生命週期與 AI token 兩條流「MUST NOT 混流」的需求是否明確，且各自載體有指定？[Consistency, Spec §FR-008, Constitution IV]
- [ ] CHK007 「任務→連線」綁定的建立時機、查無綁定時的行為、與終態清理是否都被規定？[Completeness, Spec §FR-002]
- [ ] CHK008 job 狀態集合（waiting/active/completed/failed/進度）是否完整列舉且與契約 `job/status` 對齊？[Consistency, Spec §FR-010, data-model §5]
- [ ] CHK009 concurrency（同時處理數）是否有明確假設或限制，避免與 RPM 限流語意衝突？[Gap, Spec §FR-003]
- [ ] CHK010 快取有效期內「相同機台不同狀態不得共用快取」是否被明列為需求（而非僅實作細節）？[Coverage, Spec §SC-002 案例2]

## 失敗與復原路徑（Failure & Recovery）

- [ ] CHK011 worker 崩潰／未運行時，API 與即時通道的存活需求是否明確且可驗證？[Completeness, Spec §FR-016, §SC-005, §SC-006]
- [ ] CHK012 積壓任務於 worker 恢復後「被消化」是否有可量測的完成標準？[Measurability, Spec §SC-005]
- [ ] CHK013 AI streaming 逾時（30 秒）→ `ai/error` → 重試的路徑是否完整且門檻明確？[Completeness, Spec §FR-020, Edge Cases]
- [ ] CHK014 schema 驗證失敗的處理（走 `ai/error`、MUST NOT 寫 `diagnoses`）是否無歧義地規定？[Clarity, Spec §FR-012, §SC-007]
- [ ] CHK015 重試上限與指數退避是否量化，且「達上限後標記失敗並通知」是否被規定？[Completeness, Spec §FR-003, User Story 3 案例3]
- [ ] CHK016 持鎖者逾時／崩潰不得使後續請求永久卡死，是否被列為明確需求？[Coverage, Spec §FR-006, Edge Cases]
- [ ] CHK017 發起連線在串流途中中斷／重連的處理與「跨重連不保證續傳」是否被界定為需求（含已知限制）？[Coverage, Spec Edge Cases, Assumptions]
- [ ] CHK018 對「沒有近期歷史」的機台觸發診斷的行為（最小脈絡或回報不足）是否被規定？[Edge Case, Spec Edge Cases]
- [ ] CHK019 各失敗事件的錯誤碼語意（如 `schema_invalid`／`worker_failed`）是否有一致定義來源？[Consistency, Spec §FR-012, contracts/ai-relay]
- [ ] CHK020 是否涵蓋「LLM 回傳不含可解析結構」與「結構不合法」兩種失敗，且處理一致？[Coverage, Spec Edge Cases, §FR-012]
- [ ] CHK021 是否定義無法解析／格式錯誤輸入（含 REST body 缺 `socketId`）的安全處理需求？[Gap, Spec §FR-002]

## 契約與可追溯性（Contract & Traceability）

- [ ] CHK022 `DiagnosisJobPayload` 與 `DIAGNOSIS_QUEUE` 是否明列為「先入契約再實作」的單一來源需求？[Completeness, Spec §FR-014, contracts/jobs]
- [ ] CHK023 `ai/token`／`ai/done`／`ai/error`／`job/status` 沿用既有契約、不另立平行定義是否被明確要求？[Consistency, Spec §FR-014, Constitution III]
- [ ] CHK024 `diagnoses`（僅 cache miss 實際產生）與 `diagnosisTriggers`（每次觸發含命中）的寫入條件是否清楚區分、無矛盾？[Consistency, Spec §FR-013, §FR-013a]
- [ ] CHK025 cache-hit「MUST NOT 重複寫入完整結果、改記輕量稽核」的需求是否與 SC-008 一致（無殘留舊敘述）？[Conflict, Spec §FR-013a, §SC-008]
- [ ] CHK026 `cached` 旗標在結果與稽核中的語意是否一致定義？[Clarity, Spec §FR-013a, data-model §3.2]
- [ ] CHK027 觸發稽含的欄位集合（機台／任務／發起者／時間／是否命中）是否完整列出？[Completeness, Spec §FR-013a]
- [ ] CHK028 是否建立 FR／SC 的識別碼與可追溯引用，使每條需求可對應到驗收？[Traceability, Spec Requirements]
- [ ] CHK029 context 讀取窗口（`windowMinutes`）的預設與可調性是否被明列為需求？[Clarity, Spec §FR-011]
- [ ] CHK030 至少一支純函式單元測試的覆蓋對象（簽章決定性／解析丟錯）是否明確、可驗證？[Measurability, Spec §FR-018, §SC-009]
- [ ] CHK031 需記錄（log）的六類事件是否完整列舉，且與 metrics/tracing 的範圍界線清楚？[Completeness, Spec §FR-019]

## 憲章紀律對齊（Constitution Discipline）

- [ ] CHK032 「耗時工作／LLM 呼叫／retry/backoff／rate limit MUST 在 worker、API MUST NOT 跑 long-running」是否被明列為需求？[Coverage, Spec §FR-004, Constitution IV]
- [ ] CHK033 「worker MUST NOT 直接 emit ws、token 走 Redis Pub/Sub → Gateway 轉發」是否明確？[Clarity, Spec §FR-008, §FR-009, Constitution IV]
- [ ] CHK034 Redis 連線分離（queue／pub／sub／cache，subscriber 不跑一般 command）是否被列為需求？[Completeness, Spec §FR-015, Constitution IV]
- [ ] CHK035 「LLM provider 包在 `AiProvider` interface 後、換 provider 只改 adapter」是否明列？[Clarity, Spec §FR-007, Constitution V]
- [ ] CHK036 「Cache before API」與「對同簽章去重」是否作為需求出現（非僅實作建議）？[Coverage, Spec §FR-005, §FR-006, Constitution V]
- [ ] CHK037 「AI 回傳 MUST 經 `DiagnosisResultSchema.parse()`、失敗走 `ai/error`」是否無歧義？[Clarity, Spec §FR-012, Constitution V]
- [ ] CHK038 「歷史落地 Mongo、Redis 僅暫態」的資料可追溯需求是否明列？[Consistency, Spec §FR-013, Constitution VII]
- [ ] CHK039 secrets 衛生（`GEMINI_API_KEY` 只放本機、只提交 `.env.example`）是否被列為約束？[Coverage, Spec Assumptions, Constitution VI]
- [ ] CHK040 REST 入口開發階段免授權、WS 訂閱仍需 `WS_AUTH_SECRET`——授權範圍界線是否無矛盾？[Conflict, Spec §FR-021, Assumptions]

## 驗收標準可量測性與假設（Acceptance & Assumptions）

- [ ] CHK041 SC-001 的回應性（首個 token ≤ 5 秒）與整體上限（≤ AI 逾時 + 開銷）量測起訖點是否明確，且不與 FR-020 的 30 秒 AI 逾時在邊界衝突？[Measurability, Spec §SC-001, §FR-020]
- [ ] CHK042 各 SC 是否皆為技術無關且可獨立驗證（不洩漏實作、可量測）？[Measurability, Spec Success Criteria]
- [ ] CHK043 對 Gemini／`gemini-2.5-flash`、外部 LLM 額度可用性的假設是否被記錄並標為依賴？[Assumption, Spec Assumptions]
- [ ] CHK044 可調參數（`AI_RPM`／`AI_CACHE_TTL_SECONDS`／`AI_DEDUPE_LOCK_SECONDS`／`AI_TIMEOUT_MS`／`windowMinutes`）的預設與可調性是否一致記載？[Consistency, Spec Assumptions]
- [ ] CHK045 「任務→連線記憶體 Map、重連失效」是否被明確標記為已知限制而非缺陷？[Assumption, Spec Assumptions]

## Notes

- 勾選 `[x]` 代表該需求品質面向已確認；留白代表 spec 需補強。
- 本清單為 release gate 定位，涵蓋四大焦點（非同步／並發、失敗／復原、契約／可追溯、憲章對齊）+ 驗收可量測性。
- 與 `checklists/requirements.md`（specify 階段的通用品質門檻）互補：該檔查「spec 是否寫完整」，本檔查「本 feature 特有風險的需求是否寫對」。
