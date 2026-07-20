# Observability Requirements Quality Checklist: Observability Baseline（可觀測性基線）

**Purpose**: 以「需求寫作的單元測試」審視 spec.md 的**寫作品質**——完整性、清晰度、一致性、可量測性、覆蓋度。
**不**驗證實作是否正確（那是 quickstart 的職責），只驗證需求本身是否寫得夠好到可以進 implement。
**Created**: 2026-07-20
**Feature**: [spec.md](../spec.md)
**Depth**: 標準（implement 前收斂）｜**Audience**: 作者自審 + PR reviewer
**Focus**: 可觀測性語意、零回歸與範圍邊界、運維契約、跨 feature 一致性

**第一次檢驗**: 2026-07-20 — 12 通過 / 32 待補
**spec 修訂後複驗**: 2026-07-20 — **44/44 通過**（修訂摘要見文末）

---

## 需求完整性（Requirement Completeness）

- [x] CHK001 日誌條目的最小必要欄位集合（level／時間／context）是否在**需求層**列出，而非僅存在於下游契約文件？[Completeness, Spec §FR-001]
- [x] CHK002 關聯鍵清單是否封閉？FR-002 用「至少 jobId、machineId、clientId」——「至少」是否讓驗收範圍變得不可判定？[Clarity, Spec §FR-002] — 驗收母體由 SC-002（jobId 串接）封閉，「至少」為可擴充下限，可判定。
- [x] CHK003 `LOG_LEVEL` 的「合理預設」是否給出**具體值**，且是否定義收到非法值時的預期行為？[Gap, Spec §FR-003] — 已補：預設 `info`；非法值回退預設並記警告，不中止行程。
- [x] CHK004 指標摘要間隔已定為 60s 且可調——是否定義**可調範圍或下限**，以免極小間隔與 FR-009「不得淹沒日誌」相衝突？[Gap, Spec §FR-008] — 已補：間隔 MUST 有下限，低於下限回退預設（具體值由 plan 定）。
- [x] CHK005 「佇列深度與 active／failed 計數」是否指明為**瞬時值**或**窗內增量**？兩者判讀方式完全不同。[Ambiguity, Spec §FR-008] — 已補：佇列深度／active／failed 與 WS 連線數皆明定為**瞬時值**。
- [x] CHK006 「LLM 呼叫延遲」是否指定統計形狀（樣本數／平均／百分位）？單一數字在長尾分布下無判讀價值。[Clarity, Spec §FR-008] — 已補：至少樣本數、平均、p95、最大值；明文禁止單一數字。
- [x] CHK007 「快取命中率」是否定義計算窗口（窗內 vs 累計）與**分母為零時的語意**？[Gap, Spec §FR-008] — 已補：週期內計數、每週期清零；分母為零回報「本週期無樣本」而非 0%。
- [x] CHK008 指標摘要在**部分資料來源缺席**時的預期行為是否寫入需求（中止輸出 vs 降級輸出）？[Gap, Spec §FR-008] — 已補：降級輸出——摘要照常輸出，缺席項標記不可用。
- [x] CHK009 dev 面板的「最新快照」是否定義**新鮮度上限**與資料過期時的呈現方式？[Gap, Spec §FR-008a] — 已補：MUST 標示新鮮度，逾期須以過期樣態呈現，不得看起來像即時值。
- [x] CHK010 US4 是否明確要求「零程式行為變更」，使其可與 FR-012 一致驗收，而非僅描述文件產出？[Completeness, Spec §US4] — FR-012 為全 feature 層級約束，已覆蓋 US4。

## 需求清晰度與可量測性（Clarity & Measurability）

- [x] CHK011 FR-001 的「機器可解析」是否可被客觀驗證（例如「逐行皆為合法 JSON」這類判準）？[Measurability, Spec §FR-001] — 已補判準：production 模式下每一行皆為可獨立剖析的合法 JSON；dev pretty-print 為呈現層例外。
- [x] CHK012 SC-001 的「100%」與「無殘留純文字 `console.log`」是否界定**計算母體**（哪些檔案／哪些行程算數）？[Measurability, Spec §SC-001] — 已補：母體為 api／worker 長駐服務行程的運行期日誌，明文排除 CLI 腳本與致命路徑。
- [x] CHK013 FR-009「不得逐筆記錄」是否給出可驗證門檻（如「正常路徑零日誌」），或僅為定性敘述？[Measurability, Spec §FR-009] — 已補門檻：正常路徑下每筆遙測的接收與處理 MUST 不產生任何日誌條目。
- [x] CHK014 SC-003 的「數秒內」是否量化為具體上限秒數？[Clarity, Spec §SC-003] — 已量化為 **5 秒**（對齊 008 compose healthcheck timeout）。
- [x] CHK015 FR-007 的「有限時間內」是否量化為具體逾時值，或明確授權由 plan 決定？[Clarity, Spec §FR-007] — 已明文授權由 plan 定案、須可經環境變數調整，且須使總回應時間小於 SC-003 上限。
- [x] CHK016 SC-005 的「在其設計等級被觀測到」——「設計等級」一詞是否在 spec 內有定義？未定義則此條無法判定通過與否。[Ambiguity, Spec §SC-005] — 已定義：指標摘要具**獨立於 `LOG_LEVEL` 的專屬等級**，不隨根 logger 過濾失效。
- [x] CHK017 FR-010「共存不衝突」是否給出**可驗證判準**（如命名空間不重疊、消費者互異），或僅為意向宣示？[Measurability, Spec §FR-010] — 已給三項可驗證判準。
- [x] CHK018 SC-002「只用日誌還原完整事件序列」是否明確要求關聯鍵為**獨立可過濾欄位**，而非僅出現在訊息字串中？[Clarity, Spec §SC-002] — 已補：FR-002 要求關聯鍵為獨立結構化欄位、禁止僅內嵌字串；SC-002 補「可依欄位直接過濾，無需子字串比對」。

## 需求一致性：四項已識別張力（Consistency & Conflicts）

> 以下四組是 plan 階段已識別的規格內部張力，使用者裁定**全數列為必須解決**。**四組已於 2026-07-20 的 spec 修訂中全數收斂。**

**張力① — web dev 面板 vs「範圍限後端」**

- [x] CHK019 FR-008a（web dev 面板）與 FR-013（web 端不納入）的邊界是否在需求層明確互斥，無重疊解讀空間？[Conflict, Spec §FR-008a/§FR-013] — FR-008a 明文「僅展示後端輸出的指標，MUST NOT 承擔瀏覽器端日誌蒐集／上報」，邊界互斥。
- [x] CHK020 Assumptions 的「範圍限後端（web 僅限指標 dev 面板）」與 US3 描述、FR-008a 三處敘述是否逐字一致、無殘留舊版「web 完全不在範圍」表述？[Consistency, Spec §Assumptions] — 三處一致，無殘留舊表述。
- [x] CHK021 新增 web 面板是否與 FR-014／ADR-002 §7 的拒絕清單相容——面板是否可能被解讀為變相的「指標匯出器／前端監控」？[Consistency, Spec §FR-014] — 已在 FR-014 明文補上相容說明：面板為唯讀 UI，MUST NOT 演變為機器可抓取的匯出端點。
- [x] CHK022 FR-008a 只描述「面板」，未言明需**新增通訊契約**才能把指標送到前端。此隱含需求是否應在需求層明示？[Gap, Spec §FR-008a] — 已明示：指標經既有即時通道以新增控制訊息送達，須依契約先行納入共用契約與 AsyncAPI；不新增 HTTP 端點。

**張力② — SC-001「無殘留 console.log」vs CLI 腳本豁免**

- [x] CHK023 SC-001 是否明文界定一次性 CLI 腳本（seed／smoke）在範圍**內**或**外**？目前豁免僅存在於 research，spec 讀來是無例外的絕對要求。[Gap, Spec §SC-001] — 已界定為範圍**外**，理由（終端回饋 vs 可聚合紀錄）寫入 FR-004。
- [x] CHK024 若採豁免，FR-004「MUST NOT 留下兩套並存的日誌格式」是否需同步界定其判定範圍（長駐服務 vs 一次性工具）？[Consistency, Spec §FR-004] — 已同步：FR-004 與 SC-001 使用同一組措辭界定判定範圍。

**張力③ — FR-004「不留兩套格式」vs worker 致命路徑例外**

- [x] CHK025 FR-004 是否明文承認 worker 致命路徑為例外？目前例外只寫在 research／contracts，spec 讀來不允許任何例外。[Conflict, Spec §FR-004] — 已明文承認為**唯一例外**。
- [x] CHK026 若致命路徑例外未寫入 spec，SC-001 的「100%」是否會與 007 既有運維契約產生**不可調和**的矛盾？[Conflict, Spec §SC-001] — 矛盾已解除：SC-001 的計算母體明文排除致命路徑。
- [x] CHK027 例外的**理由**（同步寫出以免致命訊息遺失）是否需在需求層留痕，使後續 reviewer 不會把它當漏改而「修正」掉？[Traceability, Gap] — 已留痕：FR-004 括號內載明 pipe 非同步寫入的遺失風險、007 運維契約來源，並明文「MUST NOT 被後續 review 當作漏改而修正」。

**張力④ — SC-007「逐項一致」的可量測性**

- [x] CHK028 SC-007 的「逐項」是否列出**具體項目清單**，使其可被客觀勾稽？未列清單則此條無法判定通過。[Measurability, Spec §SC-007] — 已列五項具名清單。
- [x] CHK029 FR-012 的「即時行為」是否定義涵蓋範圍（推送 cadence、背壓比值、streaming 延遲、優雅關閉語意）？[Clarity, Spec §FR-012] — 已補齊：SC-007 清單納入遙測推送 cadence、背壓比值、streaming 延遲與 token 順序、快取命中、**優雅關閉語意**。
- [x] CHK030 FR-012 的例外邊界是否明確——「除日誌輸出管道外」是否足以涵蓋「新增健康端點」與「新增 ws 訊息」這兩項純增添式變更？[Ambiguity, Spec §FR-012] — 已改寫：例外明列 (a) 日誌管道替換、(b) 純增添式的健康端點與指標控制訊息，並限定不得改動既有訊息形狀／cadence／端點行為。

## 運維契約需求品質（Operational Contract）

- [x] CHK031 健康端點的**路徑名稱**是否在需求層指定，或僅稱「健康端點」而把命名留給下游？下游若改名將破壞 008 的既定銜接。[Completeness, Spec §FR-005] — 已指定 `GET /healthz`。
- [x] CHK032 端點是否明文要求**免認證**？若需 secret，容器 healthcheck 與人工排查皆無法消費（FR-006 的隱含前提）。[Gap, Spec §FR-006] — 已明文 MUST NOT 要求任何認證或祕密。
- [x] CHK033 回應 body 的必要欄位是否在需求層列出，或僅泛稱「指出失聯的依賴」而未定義形狀？[Completeness, Spec §FR-005] — 已定：JSON、逐項列出各依賴 up／down 與失聯原因。
- [x] CHK034 是否明文要求健康判讀為**即時探測、不快取**？快取會直接使 SC-003 的「數秒內轉為非健康」不成立。[Gap, Spec §SC-003] — 已補：每次請求即時探測，MUST NOT 快取先前結果。
- [x] CHK035 「關鍵依賴」清單是否封閉（僅 Redis／Mongo），且 worker 存活是否**明文排除**在此端點的職責之外？[Clarity, Spec §FR-005] — 已補：清單標明「僅 Redis、Mongo，清單封閉」；worker 存活明文排除，由 007 heartbeat 與 worker 自身 healthcheck 承接。
- [x] CHK036 「008 容器 healthcheck 改由健康端點消費」目前僅出現在 Dependencies 的敘述中——是否應升格為本 feature 的**可驗收需求**？[Gap, Spec §Dependencies] — **已升格**（使用者裁定）：新增 **FR-006a**（跨 Feature 銜接），並於 SC-003 補「008 容器 healthcheck 依此端點判定 api 就緒」。

## 場景與邊界覆蓋（Scenario & Edge Case Coverage）

- [x] CHK037 依賴失聯的需求是否涵蓋**雙向**——「兩者皆 down」與「恢復後轉回健康」？現有 Edge Case 只談部分失聯。[Coverage, Spec §Edge Cases] — 已補：Edge Case 標題改為「部分或全部失聯」，明文兩者皆 down 須同時列出、恢復後下一次探測轉回 healthy。
- [x] CHK038 是否定義 api **啟動中**（依賴尚未就緒）時健康端點的預期回報？此為容器 `start_period` 內的實際狀態。[Gap, Exception Flow] — 已新增 Edge Case：未就緒視為 down／unhealthy／503，端點本身須可回應、不得掛起。
- [x] CHK039 是否定義**指標蒐集本身失敗**（讀取快照錯誤、佇列查詢逾時）時的預期行為？[Gap, Exception Flow] — 已新增 Edge Case：不中斷摘要、不影響主流程，該項標記不可用並記錯誤。
- [x] CHK040 跨重啟關聯連續性的要求（同生命週期內一致、不要求跨行程）是否**同時涵蓋 api 與 worker**？現有 Edge Case 只提 worker。[Coverage, Spec §Edge Cases] — 已改為明文「api 與 worker 兩端皆適用」。

## 跨 Feature 一致性、依賴與假設（Cross-Feature Consistency）

- [x] CHK041 Dependencies 中對 007／008 的敘述，是否與 FR-010、US2 的定案（各自獨立、不共用命名空間）**逐字一致**？[Consistency, Spec §Dependencies] — 已修正殘留舊敘述：「延續其 heartbeat 探針的命名／形狀」改為「各自獨立命名與格式、不共用命名空間，僅 MUST NOT 破壞 007 已交付的 heartbeat key」，並補上致命 log 格式為 FR-004 例外依據。
- [x] CHK042 Clarifications 的四項裁決是否已完整反映到對應 FR／SC／Assumptions，且**無殘留舊敘述**（如仍寫「留待 clarify」）？[Consistency, Spec §Clarifications] — 四項皆已落地；Assumptions 的「留待 plan／clarify」已改為「留待 plan 定案」。
- [x] CHK043 CLAUDE.md 要求的跨 feature 回補義務（指南／ADR-002／README 同步）是否在需求層有承接條目，或僅存在於 plan 而可能在收尾時被遺漏？[Gap, Traceability] — **已升格**（使用者裁定）：新增 **FR-015**（跨 Feature 回補），比照 008 FR-016 的形狀逐項列出六個回補標的，並載明「不重寫歷史」原則。
- [x] CHK044 新增環境變數是否在需求層要求同步 `.env.example`？憲章 VI 只規定不得提交祕密，未涵蓋「設定形狀須記錄」。[Gap, Spec §Assumptions] — 已新增 **FR-016**：新增環境變數 MUST 同步登錄 `.env.example` 並註明用途與預設值。

---

## Notes

- 勾選規則：該**需求寫得夠清楚／夠完整／不矛盾**才勾 `[x]`；若需回頭改 spec，留 `[ ]` 並在該行後補一句待辦。
- 本清單審查對象是 [spec.md](../spec.md)。若某項的答案是「已在 research／contracts 交代，但 spec 沒寫」，那**仍是需求缺口**——因為 spec 是驗收依據，下游文件不能替它擔保。
- 既有的 [requirements.md](./requirements.md) 是通用 spec 品質檢查；本檔是 009 專屬的領域深度檢查，兩者互補、不重複。
- 預期結果：CHK019–CHK030（四項張力）多數會**留白**，因為它們正是「已知但尚未寫回 spec」的缺口。收斂方式是回頭補 spec，或明確裁定「維持現狀、由 research 承接」。

### 檢驗與收斂紀錄（2026-07-20）

**第一次檢驗**：12 通過（CHK001、002、010、017、019、020、021、028、033、037、042）、32 待補。待補項分四類：research 已定但 spec 未寫（19 項）、真實矛盾（CHK025／026、030、041）、可量測性不足（CHK012、013、014、018、029）、範圍升格待裁定（CHK036、043）。

**收斂方式**：以一次 spec.md 修訂批次處理。使用者裁定 CHK036 採「升格 FR + 擴充 SC-003」、CHK043 採「比照 008 FR-016 逐項列名」。

**spec.md 修訂摘要**：

| 項目 | 變更 |
| --- | --- |
| Status | `Draft` → 「已收斂，待 `/speckit-tasks`」 |
| FR-001 | 補「機器可解析」判準（production 逐行合法 JSON） |
| FR-002 | 補關聯鍵須為獨立結構化欄位、禁止僅內嵌字串 |
| FR-003 | 補預設 `info`、非法值回退行為 |
| FR-004 | 補判定範圍（長駐服務）、CLI 腳本豁免、worker 致命路徑唯一例外＋理由留痕 |
| FR-005 | 補路徑 `GET /healthz`、依賴清單封閉、即時探測不快取、明文排除 worker 存活 |
| FR-006 | 補 MUST NOT 要求認證 |
| **FR-006a**（新） | 008 容器 healthcheck 改由健康端點消費，維持 Node 內建 HTTP、無外部相依 |
| FR-007 | 逾時分支回 down 不拋錯；逾時值授權 plan 定、須可調且小於 SC-003 上限 |
| FR-008 | 四項指標逐項定義統計語意（瞬時值／p95 統計形狀／窗內計數／分母為零）、間隔下限、來源缺席降級輸出 |
| FR-008a | 補新增控制訊息之契約先行要求、快照新鮮度與過期呈現、唯讀無控制項 |
| FR-009 | 補可驗證門檻（正常路徑零日誌） |
| FR-012 | 例外邊界改寫為 (a) 日誌管道替換 + (b) 純增添式健康端點與控制訊息 |
| FR-014 | 補與 FR-008a 面板的相容說明 |
| **FR-015**（新） | 跨 Feature 回補義務，逐項列出六個標的，載明不重寫歷史 |
| **FR-016**（新） | 新增環境變數須同步 `.env.example` |
| SC-001 | 界定計算母體並排除 CLI 腳本與致命路徑 |
| SC-002 | 補關聯鍵可依欄位直接過濾 |
| SC-003 | 「數秒內」量化為 5 秒；補容器就緒判定 |
| SC-005 | 定義「設計等級」為獨立於 `LOG_LEVEL` 的專屬等級 |
| SC-007 | 逐項清單具名化，補優雅關閉語意 |
| Edge Cases | 補「兩者皆失聯／恢復」、新增「api 啟動中」與「指標蒐集自身失敗」、關聯連續性擴及 api |
| Dependencies | 修正 007 敘述與 FR-010 的矛盾，補致命 log 契約為 FR-004 例外依據 |
| Assumptions | 「留待 plan／clarify」→「留待 plan 定案」 |

**下游影響**：research.md 的決策未被推翻，僅被回寫進 spec；contracts／plan 無需改動。新增的 FR-006a／FR-015／FR-016 需在 `/speckit-tasks` 產生對應任務。

### `/speckit-analyze` 複驗與修補紀錄（2026-07-20，tasks 產出後）

analyze 的跨工件一致性檢查發現 11 項（0 CRITICAL、6 MEDIUM、5 LOW），已全數修補。
其中兩項直接**回頭收緊本清單先前留下的門檻**——當時判為「已授權由 plan 定」，但 plan／tasks
實際都沒有釘死具體值，實作時會被迫臨場決定：

| 原檢查項 | 當時的收斂 | analyze 修補後的現況 |
| --- | --- | --- |
| CHK004（間隔下限） | 「間隔 MUST 有下限，**具體值由 plan 定**」 | **釘為 5000ms**，低於下限回退預設 60000（非 clamp）。落地於 FR-008／research R11／T009／T010 |
| CHK009（面板新鮮度） | 「MUST 標示新鮮度，逾期須以過期樣態呈現」 | 過期門檻**釘為 2 × `METRICS_INTERVAL_MS`**（預設 120s）。落地於 FR-008a／contracts/metrics-summary.md §2.1／T049／quickstart 6.2 |

**教訓**：「授權由下游定案」只有在下游**真的定案**時才算收斂；若 plan 與 tasks 都只是複述
「須有下限」，這個缺口會一路滑到 implement。後續 feature 的 checklist 收斂 SHOULD 在標記
「由 plan 定」時同步確認 plan 是否已給出值。

其餘九項修補：FR-003 的警告**輸出**補 T011a（原本只有純函式回報、沒有人真的印出來）；
FR-010 的 heartbeat 共存補 T042 禁令與 quickstart 8.9；容器內 pino 相依驗證併入 quickstart 3.5；
純函式測試數統一為 **6**（補 `resolveMetricsInterval`）；`unavailable` 措辭統一為 `worker: null`；
`METRICS_INTERVAL` 統一為 `METRICS_INTERVAL_MS`；plan 檔案清單補 `interval.ts`；
T031 補「healthcheck.ts 的舊 doc 註解須一併改寫」（`/healthz` 落地後「api 無任何 GET 路由」即不成立）；
research R1b 的 `⚠️ 需確認` 結案為已定案。

---

### `/speckit-analyze` 第二輪複驗與修補紀錄（2026-07-20）

第二輪檢查發現 9 項（0 CRITICAL、1 HIGH、4 MEDIUM、4 LOW），已全數修補。
其中三項需使用者裁定，裁定結果如下：

| ID | 問題 | 裁定／修補 |
| --- | --- | --- |
| **E1**（HIGH） | `VITE_METRICS_PANEL` 只登錄在根 `.env.example`，但 `apps/web/vite.config.ts` 未設 `envDir`，Vite 的 env 根目錄是 `apps/web/`——**該變數永遠讀不到**，FR-016 在 web 端形同未落地，T052 的旗標在 dev 直接失效 | **裁定：新增 `apps/web/.env.example`**（與既有每-app 慣例一致），`envDir` 不動。新增 **T004a**；根 `.env.example` 保留一列作總覽並註明實際來源。FR-016 同步收緊為「登錄位置 MUST 是實際生效的那一份」 |
| **E3**（MEDIUM） | `METRICS_INTERVAL_MS` 下限回退的 `warn` 同時要求在 `createLogger`（T011a）與 `config.service`（T048）處理，可能重複輸出或雙方互推致漏輸出 | **裁定：由呼叫端各自輸出**。`createLogger` 只管 `LOG_LEVEL` 那一則；間隔回退的 warn 歸 T048（api）與 T042（worker） |
| **E4**（MEDIUM） | quickstart 6.2 以「停掉 api」驗過期樣態，但停 api 會**同時斷 ws**，過期態與斷線態混在一起，FR-008a 的判準無從被證實 | **裁定：面板區分兩態**。狀態機擴為 `empty`／`live`／`stale`／`disconnected`（見 research R12、contracts §2.1），FR-008a 同步收緊；quickstart 6.2 改為分段驗證 |

其餘六項：**E2** T042 補「worker 側摘要 MUST 用專屬 metrics child logger」（原措辭只要求 `context: "metrics"`，
若誤用一般 logger 則 `LOG_LEVEL=warn` 時 worker 摘要會消失、SC-005 在 worker 側不成立），
quickstart 場景 5 判準同步拆為 api／worker 兩端；
**E5** T049 的過期門檻改由 payload `windowMs` 推導（後端環境變數前端讀不到），未收快照時為 `empty`；
**E6** tasks 兩處對 US4 相依性的敘述矛盾（「只依賴 Phase 1」vs「零相依」），統一為零相依；
**E7** T061 補 FR-013／FR-014 的邊界搜尋詞（`/metrics`、`prometheus`、`opentelemetry`、`tracing` 等）
——這兩條否定式需求原本無任何任務守門；
**E8** plan.md §Project Structure 的 `lib/` 目錄重複列示，併回同一區塊；
**E9** T062 補場景 6 的前置（`WS_AUTH_SECRET` 須為空、`VITE_METRICS_PANEL` 放 `apps/web/.env`）。

**教訓**：第一輪 analyze 只比對「工件之間」是否一致，未比對「工件與實際建置設定」是否一致——
E1 正是這類缺口（tasks 與 plan 彼此完全一致，但都與 `vite.config.ts` 的實際行為不符）。
後續 feature 的 analyze SHOULD 對**新增設定項**額外確認其在真實建置鏈上會被讀取。

### 事實斷言逐項驗證（2026-07-20，取代第三輪 analyze）

依上述教訓，改以**針對性驗證**取代再跑一輪工件對工件的 analyze——逐項核對 plan／research
對現有程式碼與建置設定所做的事實斷言。結果：**7 項符合、1 項需修正**。

| 斷言 | 出處 | 核對結果 |
| --- | --- | --- |
| `packages/shared` 的 `rootDir: src` / `outDir: dist` 可產生 `dist/logging/index.js` | T002 | ✅ 符合 |
| `apps/web` 確實相依 `@flow-gatekeeper/shared`（`telemetry-format.ts` 匯入 `METRIC_THRESHOLDS`） | research R10 | ✅ 符合——pino 進 bundle 的風險屬實，子路徑 export 有必要 |
| api 已全面使用 Nest `Logger`，共 **6 處** | research R1 | ✅ 精確符合（`main`／`history`／`jobs`／兩支 relay／gateway） |
| worker `log()` helper 位於 `main.ts:35`，呼叫點約 20 | research R1／T017 | ✅ 實測 18–19 處，「約 20」成立 |
| 全案殘留 `console.*` 僅 `seed.ts`／`smoke-gemini.ts`／`fatal.ts` | FR-004／SC-001 範圍界定 | ✅ 精確符合——三處皆為已明文豁免者，SC-001 的 100% 判準可達成 |
| compose api healthcheck 的 `test` 為 `["CMD","node","dist/healthcheck.js"]`、不需變更 | T031 | ✅ 符合（`docker-compose.yml:88-93`） |
| healthcheck 自我逾時 4000ms < compose `timeout: 5s` | T031／research R4a | ✅ 符合 |
| quickstart 3.5 停 Redis 後等 **60s** 即應見容器 `unhealthy` | quickstart 3.5 | ❌ **不成立，已修正**——compose 為 `interval: 30s` / `retries: 3`，需連續 3 次失敗才翻牌，最壞約 90s+。等 60s 會看到仍是 `healthy` 而**誤判驗收失敗**。已改為 120s，並補「判準是最終翻牌而非翻牌速度」與恢復方向的驗證 |

**結論**：斷言基礎穩固，唯一缺陷是驗收演練的等待時間算錯——同樣屬「工件 vs 真實設定」這一類，
而非工件互相矛盾。兩輪 analyze 已把工件互相矛盾這一類掃過兩遍（第二輪 9 項中僅 1 項 HIGH，
且該項無法由工件互比發現），本輪針對性驗證又已覆蓋剩餘的高風險類別，**判定不再跑第三輪
analyze**，直接進入 `/speckit-implement`。殘餘風險改由 implement 各 phase 的
typecheck／lint／test 與 quickstart 逐項演練承接。
