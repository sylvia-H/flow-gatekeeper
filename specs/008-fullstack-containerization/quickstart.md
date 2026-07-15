# Quickstart: Full-Stack Containerization & One-Command Demo（Phase 1）

可重播的驗收場景，對應 spec 的 US1–US4 與 SC-001–SC-007。環境為 **Windows + PowerShell + Docker Desktop**。

契約細節見 [contracts/deployment-runtime.md](./contracts/deployment-runtime.md)；決策理由見 [research.md](./research.md)。本檔只寫「怎麼跑、該看到什麼」，不含實作碼。

## 前置需求

1. Docker Desktop 執行中（linux 容器）。
2. 已 clone 本 repo。
3. 複製兩份設定範本並填值：

   ```powershell
   Copy-Item apps/api/.env.example    apps/api/.env
   Copy-Item apps/worker/.env.example apps/worker/.env
   # 編輯 apps/worker/.env，填入 GEMINI_API_KEY
   ```

   `apps/api/.env` 可全用預設值。**不需要**安裝 Node 或 pnpm（SC-001）。

> **首次啟動需建置三個映像**，視網路與機器約需數分鐘。這是預期行為，不是卡住（Edge case：首次啟動的建置成本）。

---

## 場景 1（US1）— Gateway 的受監督可部署形態

> **場景 1 的拓樸（與場景 2 不同，請勿混用）**：US1 交付時 **web／seed 容器尚不存在**（T012／T013 才建立），故本場景以**指名服務**只起 `api`＋`worker`，前端用既有的 host dev server 連上——這正是 spec US1 Independent Test 定義的驗收形狀（「用現行本機前端連上這個容器化 Gateway」）。連線路徑為 `localhost:5173`（vite dev）→ proxy → `localhost:3000`（api 容器的 **US1 專用暫時發佈**，tasks T008，於 T012 移除）。
>
> 全棧單一入口（`8080`）的驗收在**場景 2**。本場景的前置與開發模式相同（需 Node／pnpm），這不牴觸 SC-001——SC-001 規範的是**全棧 demo** 的前置需求，由場景 2a 驗收。

### 1a. 啟動並確認一致性

```powershell
# 示範資料：Phase 3 尚無 seed 容器，用既有指令備妥
# （host 本就需 Node／pnpm 才能跑 dev 前端，故無額外前置）
pnpm --filter api seed

# 指名服務——不帶服務名會連 web／seed 一起拉起，本 phase 尚未建立
docker compose --profile demo up -d --build api worker
docker compose ps
```

**預期**：`redis`／`mongo`／`api`／`worker` 為 `running`（api、worker 在 `start_period` 過後轉 `healthy`）；**`web`／`seed` 不在清單中**。

另開一個終端機起 host 端前端，開 `http://localhost:5173`：

```powershell
pnpm --filter web dev
```

逐項比對與現行 host 直跑模式（**唯一差異是 api 在容器內**——前端、資料層與 seed 資料兩邊完全相同，故任何差異都可歸因於容器化）：

| 項目 | 預期 |
|---|---|
| 即時連線 | 監控台自行建立通道，持續收到遙測 |
| 背壓比值 | 與現行模式**同量級**（非同值——mock producer 是時間驅動的） |
| 訂閱過濾 | 只收到已訂閱機台的遙測 |
| 心跳 | 連線不因閒置而斷 |
| 認證語意 | **見 1g**——預設 `WS_AUTH_SECRET` 留空時此路徑不會被走到，須另行實測 |

### 1b. 診斷 streaming 與快取（SC-002）

觸發一筆診斷 → AI token 逐字出現 → 結果通過結構驗證 → **同一台再點一次** → 顯示 Cached。

> 若想重看串流，執行 `./scripts/demo-reset.ps1`（只清 `ai-cache:*`／`ai-lock:*`，不碰遙測歷史）。

### 1c. 崩潰自動重啟（SC-003）

```powershell
docker kill --signal=SIGKILL $(docker compose ps -q api)
docker compose ps        # api 應在數秒內回到 running
```

**預期**：無需人工介入，`http://localhost:5173` 的前端 **≤ 30s** 內重新連上並繼續收到遙測（起算點：`docker kill` 送出當下）。

> 「崩潰重啟不重置示範資料」（US2 場景 5）在本 phase **不適用**——那是 seed 容器的 `depends_on` 語意，seed 於 T013 才建立，故該項在**場景 2f** 驗收。

### 1d. 優雅關閉（SC-005）

```powershell
Measure-Command { docker compose --profile demo stop api }
docker inspect --format='{{.State.ExitCode}}' $(docker compose ps -aq api)
```

**預期**：退出碼 **0**、監督者**不重啟**；收尾耗時 **≤ 3s**（`Measure-Command` 的 `TotalSeconds`）。

> **為何是 3s**：收尾只是關閉 ws 連線、Mongo client 與兩個 Redis subscriber，量級為秒內；3s 已給足餘裕，且距 15s 上限有 5 倍距離，「遠低於上限」（SC-005）因而可客觀判定。**超過 3s 即屬缺陷**——代表收尾路徑有非預期阻塞，正解是查阻塞點，**不是把寬限期或本門檻調大**。

### 1e. 重啟上限耗盡的判讀（research D10）

api 連續崩潰 5 次後停止重啟。**症狀**：本場景（dev 前端）為「畫面正常載入、但即時通道永遠連不上」；全棧模式下形狀相同（web 入口正常載入、通道連不上）——**兩者的判讀指令一致**。判讀：

```powershell
docker compose ps                                              # api 狀態欄應為 exited
docker inspect --format='{{.RestartCount}} {{.State.Status}}' $(docker compose ps -aq api)
docker compose logs api                                        # 看崩潰原因
```

### 1f. 資料層未就緒不卡死（US1 場景 5）

整組同時啟動時，api／worker 不得因搶先連線而永久卡在失敗狀態——最終仍應自行進入可服務狀態。1a 的正常啟動即已涵蓋此路徑。

### 1g. 認證語意一致（FR-001）

> **為何需要獨立一節**：FR-001 要求逐項一致的六項中，認證是**唯一不會被預設設定走到**的一項——`apps/api/.env.example` 的 `WS_AUTH_SECRET` 預設留空，而 Gateway 只在「有設密鑰時」才驗證（[monitoring.gateway.ts:95](../../apps/api/src/modules/websocket/monitoring.gateway.ts#L95)）。照 1a 的預設值跑一輪，容器化後的授權路徑一次都不會被執行，缺陷會安靜地躲過整個 US1 驗收。

**1. 暫時設密鑰**：在**編輯器**裡把 `apps/api/.env` 的 `WS_AUTH_SECRET=` 改為 `WS_AUTH_SECRET=demo-secret`，然後重建 api 容器吃新 env（不需 `--build`）：

```powershell
docker compose --profile demo up -d api
```

> **MUST NOT 用 `(Get-Content …) -replace … | Set-Content` 改 `.env`**：PowerShell 5.1 的 `Get-Content` 以 ANSI 讀檔，會把 `.env` 裡的中文註解整段毀掉（`.env` 是從 `.env.example` 複製來的，含大量中文說明）。用編輯器改，或確認 `-Encoding utf8` 讀寫兩端都指定。

**反向路徑（瀏覽器）**：重整 `http://localhost:5173` → 前端收到 `system/unauthorized`、**不建立訂閱、無遙測進畫面**。

> **前端必然被拒，這是現況、不是缺陷**：[App.vue:143](../../apps/web/src/App.vue#L143) 把 `token: ""` **寫死**在 `machine/subscribe` 訊息裡（004 起即如此，dev 送空 token），故瀏覽器**沒有任何管道**帶有效 token。正向路徑因此 MUST 以原生 ws client 驗，不能用畫面驗——**MUST NOT 因為前端連不上就判定容器化壞了**。

**正向路徑（原生 ws client）**：

```powershell
# 用 Node 22 的全域 WebSocket，不需 require('ws')——repo root 無法解析 apps/api 的相依
node -e "const w=new WebSocket('ws://127.0.0.1:3000/ws');w.onopen=()=>w.send(JSON.stringify({type:'machine/subscribe',token:'demo-secret',machineIds:['mixer-01']}));w.onmessage=e=>console.log(String(e.data).slice(0,120));setTimeout(()=>process.exit(0),4000)"
```

**預期**：先 `system/connected`，帶對 token 後收到 `machine/subscribed`，接著開始收到 `mixer-01` 的 `telemetry/*`。

**2. 還原留空**（同樣用編輯器）並重建——後續場景與 SC-001 的前置皆以「預設值」為準：

```powershell
docker compose --profile demo up -d api
```

**預期**：前端恢復訂閱與遙測。三項行為（空密鑰＝開放、錯 token＝拒絕且不訂閱、對 token＝訂閱成立）MUST 與 host 直跑模式一致。

---

## 場景 2（US2）— 一鍵起全棧、單一入口走完 demo

### 2a. 乾淨環境一鍵啟動（SC-001）

在只裝 Docker、剛 clone、已填祕密的機器上：

```powershell
docker compose --profile demo up -d --build
```

**預期**：**1 道指令**、**1 個位址**（`http://localhost:8080`）、**不需安裝任何語言執行環境或套件管理器**。

#### 「全部就緒」的判讀（FR-011 的複合訊號）

FR-011 要求展示者能**辨識**可以開始 demo 的時點，而非肉眼猜測。判讀指令（**`-a` 不可省**——seed 完成後即 exited，預設的 `docker compose ps` 不列出已結束的容器，會讓複合訊號的第一項無從判讀）：

```powershell
docker compose ps -a
```

**預期**（四項全部成立才算就緒——單一服務健康不代表可 demo）：

| 服務 | 就緒的樣子 | 未就緒時代表 |
|---|---|---|
| `seed` | `exited (0)` | 非 0 → 示範資料備妥失敗，api 不會啟動（見 Edge case） |
| `api` | `running (healthy)` | `start_period` 30s 內顯示 `starting` 屬正常；逾時未 healthy → `/ws` 未可服務 |
| `worker` | `running (healthy)` | heartbeat 未更新（007 探針） |
| `web` | `running (healthy)` | 入口位址無回應 |

> **首次啟動請等映像建置完成**（數分鐘）；`api` 的 `start_period` 為 30s，故 `up` 回傳後約半分鐘內顯示 `starting` 是預期行為，不是失敗。
>
> **已知限制（spec 明文接受）**：本判定**不涵蓋** Mongo／Redis 連通性——api 可能握手成功但資料層斷線而仍顯示 `healthy`。該深度屬 Feature 009 的觀測基線。

### 2b. 四個賣點全在單一入口下重現（SC-002）

開 `http://localhost:8080`，確認：即時遙測 ✓、背壓比值 ✓、AI 診斷 streaming ✓、快取命中 ✓。**不需手動指定後端位址**。

#### 靜態伺服的一致性（FR-002）

四個賣點之外，另須確認**換 nginx 送靜態檔沒有改變視覺與互動**——這兩項是 vite dev server 換成 nginx 後最可能壞、且四個賣點驗不到的地方：

| 項目 | 預期 | 壞掉的樣子 |
|---|---|---|
| 靜態資產 | 重整後 DevTools Network 面板**無任何 404**（JS／CSS chunk、圖示、字型全數 200） | 建置產物的資產路徑與 nginx root 對不上——畫面掉字型／破圖，但四個賣點照樣「可見」，故四項賣點驗不到這一層 |
| 視覺比對 | 與開發模式（`localhost:5173`）**逐區塊一致**：拓樸卡片、狀態色、背壓面板、AI 面板的間距與圓角無差異 | 同上——只有並排比對看得出來 |
| 未知路徑 | `http://localhost:8080/x` 回 **index.html**（非 nginx 的 404 頁） | `try_files $uri $uri/ /index.html` 沒生效 |

> **未知路徑一項為何仍要驗**：本專案目前**沒有 vue-router**（單一視圖、無深連結），使用者不會走到這條路徑。但 nginx 對未知路徑的**預設行為是 404**，而 vite dev server 的預設是回 `index.html`——留著不驗，就是在 demo 路徑上埋一個與 dev 模式不一致的行為（FR-014）。這項驗的是 T010 的 `try_files` 指令本身有生效，成本是一次 curl。

### 2c. 示範資料自動備妥（US2 場景 4）

```powershell
docker compose logs seed        # 應見 "seeded maintenanceRecords"、exited (0)
docker compose --profile demo up -d    # 再跑一次
```

**預期**：seed 再執行一次且**資料不堆積**（`deleteMany` → `insertMany` 冪等）；展示者無需執行第二道指令。

### 2d. 非預設入口埠（Edge case）

把 compose 的 `web.ports` 由 `8080:80` 改為例如 `9090:80`，重起後開 `http://localhost:9090`——**前端仍須能連上**（同源相對路徑使其自然成立）。**MUST 實測一次**，不得只靠推論。

### 2e. 金鑰留空的行為（FR-017 / SC-002 反面）

清空 `apps/worker/.env` 的 `GEMINI_API_KEY` 後重起 worker，觸發診斷：

**預期**：全棧照常啟動；遙測與背壓**正常**（2/4 賣點仍可見）；診斷失敗且**畫面訊息指名金鑰**（如「AI 服務金鑰無效或未授權」），**不是**通用的「診斷失敗，請重試。」

> **MUST 真的留空實測**——空金鑰與無效金鑰的供應商回應未必相同，不得以無效金鑰的結果推斷（research D11）。若落入通用文案，須補既有映射並補一則單元測試。

### 2f. 崩潰重啟：demo 拓樸下的重連與資料保全（SC-003 / US2 場景 5）

> **為何場景 1c 之外還要再做一次**：1c 的重連路徑是 dev 前端直連 api（不經 nginx），**與 demo 實際拓樸不同**。SC-003 要保證的是展示者在 demo 當下看到的行為，而該路徑穿過 nginx——反向代理對 upstream 的解析與連線復原是 1c 完全沒驗到的一段。此外 US2 場景 5（資料不重置）需要 seed 容器存在，1c 當時尚無。

先記下一筆可辨識的示範資料狀態（供重啟後比對），再從 `http://localhost:8080` 觸發一次診斷確認通道正常，然後：

```powershell
docker kill --signal=SIGKILL $(docker compose ps -q api)
docker compose ps                       # api 應在數秒內回到 running
docker compose logs seed                # 應仍是「上一次」的執行紀錄，未新增
```

**預期**：

| 項目 | 預期 |
|---|---|
| 重連（SC-003） | **不重整瀏覽器**，`http://localhost:8080` 的通道 **≤ 30s** 自行重連並繼續收到遙測（起算點：`docker kill` 送出當下） |
| 代理復原 | 重連後 `/ws` 與 `/diagnoses` 皆正常——**不得出現持續 502**（nginx 若把 upstream IP 快取成失效位址，症狀正是「web 載入正常但通道永遠連不上」，與重啟上限耗盡的症狀**同形**，故 MUST 以 `docker compose ps` 確認 api 確實 `running` 來區分兩者） |
| 資料保全（US2 場景 5） | 示範資料**維持原狀、未被重置**；`seed` 未重跑（`depends_on` 只在啟動編排時求值，research D7／CHK044） |

> 若出現持續 502 而 api 為 `running`，即為 nginx upstream 解析快取問題——處置見 [research.md](./research.md) D1「upstream 解析」段，**不得以「重整瀏覽器就好」帶過**（SC-003 明文要求不需人工介入）。

---

## 場景 3（US3）— 開發模式零影響（SC-004）

```powershell
docker compose --profile demo down
docker compose up -d      # 不帶 profile
docker compose ps
```

**預期**：**只有 `redis`／`mongo` 在跑**——`api`／`worker`／`web`／`seed` 皆未被拉起。這由 compose profiles 的機制保證，非靠紀律。

接著跑既有開發流程並確認熱重載照常：

```powershell
./scripts/dev-up.ps1      # host 直跑 api/worker/web，開四個終端機
```

改一行前端與一行後端 code → 熱重載行為與本 feature 之前**完全一致**；步驟數不變。

**場景 3 的第三項**：從 demo 模式切回開發模式**不需額外清理步驟**（`down` 後直接 `up -d` + `dev-up.ps1` 即可）。

> **不要同時跑兩種模式**——`redis`／`mongo` 為兩模式共用，且 demo 的 8080 與 dev 的 5173 雖不互撞，資料層仍會互相干擾。

---

## 場景 4（US4）— 乾淨收場與可重播

### 4a. 停止（SC-005）

```powershell
docker compose --profile demo down
docker compose ps -a
netstat -ano | Select-String ":8080"      # 應無結果
```

**預期**：所有服務在各自寬限期內結束；**0 個殘留行程佔用相關連接埠**。

### 4b. 連同資料清除的重設並重播

```powershell
docker compose --profile demo down -v
docker compose --profile demo up -d --build
```

**預期**：volume 清空 → seed 重跑 → 系統回到初始狀態 → **同一份劇本可重跑並得到同等結果**。

---

## 祕密衛生驗收（SC-006）

```powershell
# 三個映像內皆不應有任何 .env
docker run --rm --entrypoint sh flow-gatekeeper-api:local -c "find / -name '.env' 2>/dev/null | head"
docker run --rm --entrypoint sh flow-gatekeeper-worker:local -c "find / -name '.env' 2>/dev/null | head"
docker run --rm --entrypoint sh flow-gatekeeper-web:local -c "find / -name '.env' 2>/dev/null | head"

git status --porcelain     # 不得出現任何 .env（.gitignore 已忽略，放行 .env.example）
```

**預期**：三個映像內祕密數皆為 **0**；設定範本以外的祕密檔案未進版控。

---

## 文件驗收（SC-007）

請一位沒跑過本專案的人**只讀 `README.md`**，在不詢問任何人的前提下：

1. 正確選出自己要用的模式（開發 vs 一鍵 demo）；
2. 完成啟動。

**預期**：兩種模式的指令、用途與前置需求**各自成段、不混淆**；README 與指南中**不殘留任何 `supervised` 分組的現況敘述**（FR-016——歷史敘述可保留，但須標註已更名）。
