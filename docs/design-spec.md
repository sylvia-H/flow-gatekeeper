# flow-gatekeeper Claude Design 規格 003

> ⚠️ **已移轉，本檔為歷史起點，不再更新。** canonical 規格在
> [`apps/web/design/design-spec.md`](../apps/web/design/design-spec.md)（含 v0.4 起的 token 回寫與 `refs/`；**現況為 v0.5**——2026-09-27 審查修正：`colors.base` 改名 `canvas`、`fg-subtle` 提亮、補 `fontSize` token、背壓計量含丟棄筆數等）。
> 前端一切以該檔為準；本檔僅保留 v0.3 交接原貌供追溯。

> 這份文件是 Claude Design 與 Spec Kit / Claude Code 之間的交接契約。  
> 使用方式：Claude Design 負責產生視覺參考圖與 token；coding agent 只依本檔與 `refs/` 實作，不憑空發明色票、間距或元件狀態。

---

## 0. 檔案位置與資產

建議放置路徑：

```text
apps/web/design/
  design-spec.md
  refs/
    layout.png
    node-states.png
    copilot-drawer.png
```

| 項目 | 內容 |
| --- | --- |
| Spec 版本 | `v0.3` |
| 最後更新 | `2026-06-29` |
| 產品 | flow-gatekeeper |
| 風格 | 致敬 Argo CD 的暗色 operational dashboard |
| 主要使用者 | 想監控高頻流程狀態、查看 AI 診斷的工程/維運使用者 |
| 實作技術 | Vue 3、Tailwind、Pinia、lucide icons |

更新紀律：

1. Claude Design 改視覺後，先重新輸出對應截圖。
2. 更新本檔 token、layout、component state。
3. 更新 Tailwind `theme.extend`。
4. 再讓 coding agent 修改元件。

---

## 1. 給 Coding Agent 的硬性規則

- 本檔與 `refs/` 截圖是前端視覺唯一真實來源。
- 顏色、圓角、陰影、狀態樣式一律使用具名 token，不在元件內散落 hex。
- 若截圖與本檔文字衝突，以本檔的 token 與尺寸為準，並在實作摘要中提醒使用者。
- 第一屏必須是可操作的監控台，不做 landing page。
- 卡片圓角不超過 8px，除 badge/pill 外不使用過度圓潤造型。
- 按鈕優先使用 lucide icon 搭配 tooltip；清楚命令才使用文字按鈕。
- 不使用官方 Argo CD logo、商標或直接複製官方素材。
- 不使用大面積紫色漸層、裝飾光球、bokeh 背景。
- mobile/desktop 都不能有文字溢出或 UI 重疊。

---

## 2. Claude Design 工作流

### 2.1 一次只做一層

建議順序：

1. `layout.png`：整體 dashboard 外殼、三欄/兩欄布局、視覺基調。
2. `node-states.png`：機台節點卡片與 healthy/warning/critical/selected/stale/hover。
3. `copilot-drawer.png`：AI Copilot drawer、progress、streaming、結果區。

每次完成一層後都要：

1. 存圖到 `refs/`。
2. 請 Claude Design 輸出 token 與 component notes。
3. 寫回本檔。
4. 若 token 有變，更新 Tailwind config。

### 2.2 Layout Prompt

```text
Design a dark operational dashboard for a side project called flow-gatekeeper, inspired by the topology/status language of Argo CD but not copying its brand assets.

The first screen must be the actual monitoring console, not a marketing page.
Create a dense but readable layout with:
- left sidebar for machine groups
- top bar with connection status, search, mock frequency control, and diagnose action
- central topology or node grid
- right AI Copilot drawer
- optional bottom event strip

Use a restrained engineering visual style. Avoid purple gradients, decorative blobs, and rounded oversized cards. Provide design tokens for colors, typography, spacing, border radius, shadows, and component states.
Output one desktop reference image and list the exact tokens.
```

### 2.3 Node States Prompt

```text
Using the same flow-gatekeeper design tokens, design the MachineNodeCard component states:
- healthy
- warning
- critical
- selected
- stale
- hover

Each card must show machine id, current state, temperature, vibration, throughput, error rate, last updated time, and a diagnose icon button.
Critical state should be urgent but not visually noisy. Provide exact color tokens, border styles, status light behavior, hover/selected state, and animation guidance.
```

### 2.4 Copilot Drawer Prompt

```text
Using the same flow-gatekeeper design tokens, design the AI Copilot drawer.

It must support:
- idle state
- active BullMQ job with progress
- streaming AI tokens
- completed diagnosis with severity, likely causes, evidence, suggested actions, and cached badge
- failed state with retry

The drawer should feel like an engineering tool: compact, readable, and suitable for repeated use. Provide exact spacing, typography, colors, component states, and mobile bottom-sheet behavior.
```

---

## 3. 產品視覺方向

flow-gatekeeper 應該像一個可長時間盯著看的維運工具，而不是展示型首頁。

關鍵形容詞：

- 深色
- 低飽和
- 工程感
- 資訊密度中高
- 狀態清楚
- 動效克制
- 適合反覆操作

視覺語言：

| 概念 | 表現方式 |
| --- | --- |
| topology | 中央 node grid / topology canvas |
| sync/status | 狀態燈、badge、progress bar |
| operations | top bar controls、diagnose icon button |
| diagnosis | right drawer / mobile bottom sheet |
| high-frequency telemetry | mono 數值、last updated、stale state |

---

## 4. Design Tokens

> 「建議預設」可直接用於第一版實作。Claude Design 產出後，如果有更好的值，把「最終值」更新掉並同步 Tailwind config。

### 4.1 Colors

| Token | 用途 | 建議預設 | 最終值 |
| --- | --- | --- | --- |
| `bg-base` | app 最底層背景 | `#0B1014` | `#0B1014` |
| `bg-surface` | panel、主內容背景 | `#111820` | `#111820` |
| `bg-elevated` | drawer、popover、浮層 | `#17212B` | `#17212B` |
| `bg-inset` | topology grid、log 區內凹背景 | `#0E151B` | `#0E151B` |
| `border-subtle` | 分隔線、卡片邊框 | `#26323D` | `#26323D` |
| `border-strong` | selected、active 邊框 | `#3E5266` | `#3E5266` |
| `text-primary` | 主要文字 | `#E7EDF2` | `#E7EDF2` |
| `text-secondary` | 次要文字 | `#9AA8B5` | `#9AA8B5` |
| `text-muted` | metadata、placeholder | `#687684` | `#687684` |
| `accent` | selected、primary action | `#4FA3FF` | `#4FA3FF` |
| `accent-hover` | primary action hover | `#76B8FF` | `#76B8FF` |
| `accent-bg` | subtle selected background | `#102A42` | `#102A42` |
| `ok` | healthy / success | `#37C978` | `#37C978` |
| `ok-bg` | healthy subtle background | `#123522` | `#123522` |
| `warn` | warning | `#F2B84B` | `#F2B84B` |
| `warn-bg` | warning subtle background | `#3A2B12` | `#3A2B12` |
| `crit` | critical / failed | `#FF5C66` | `#FF5C66` |
| `crit-bg` | critical subtle background | `#3B151A` | `#3B151A` |

### 4.2 Typography

| Token | 用途 | 建議預設 | 最終值 |
| --- | --- | --- | --- |
| `font-sans` | 一般 UI | `Inter, ui-sans-serif, system-ui` | `Inter, ui-sans-serif, system-ui` |
| `font-mono` | machine id、數值、log、job id | `JetBrains Mono, ui-monospace, monospace` | `JetBrains Mono, ui-monospace, monospace` |
| `text-xs` | metadata、badge | `12px / 16px` | `12px / 16px` |
| `text-sm` | 一般 UI | `14px / 20px` | `14px / 20px` |
| `text-md` | panel title | `16px / 24px` | `16px / 24px` |
| `text-lg` | page title | `20px / 28px` | `20px / 28px` |
| `text-number` | telemetry value | `22px / 28px` | `22px / 28px` |

文字規則：

- 不用負 letter spacing。
- 不用 viewport width 直接縮放 font-size。
- 數值使用 mono，減少寬度跳動。
- compact panel 內不要使用 hero-scale 大字。

### 4.3 Shape、Spacing、Shadow

| Token | 用途 | 建議預設 | 最終值 |
| --- | --- | --- | --- |
| `radius-card` | card、panel | `8px` | `8px` |
| `radius-control` | input、button、select | `6px` | `6px` |
| `radius-pill` | badge、status chip、progress | `999px` | `999px` |
| `space-1` | base unit | `4px` | `4px` |
| `space-2` | compact gap | `8px` | `8px` |
| `space-3` | normal gap | `12px` | `12px` |
| `space-4` | section gap | `16px` | `16px` |
| `space-6` | large gap | `24px` | `24px` |
| `shadow-card` | card elevation | `0 1px 0 rgba(255,255,255,0.04), 0 12px 28px rgba(0,0,0,0.22)` | 同建議 |
| `shadow-drawer` | right drawer | `-18px 0 36px rgba(0,0,0,0.35)` | 同建議 |

---

## 5. Tailwind 對應

貼到 `apps/web/tailwind.config.ts` 的 `theme.extend`。

```ts
export default {
  theme: {
    extend: {
      colors: {
        base: '#0B1014',
        surface: '#111820',
        elevated: '#17212B',
        inset: '#0E151B',
        subtle: '#26323D',
        strong: '#3E5266',
        fg: '#E7EDF2',
        'fg-muted': '#9AA8B5',
        'fg-subtle': '#687684',
        accent: {
          DEFAULT: '#4FA3FF',
          hover: '#76B8FF',
          bg: '#102A42',
        },
        ok: {
          DEFAULT: '#37C978',
          bg: '#123522',
        },
        warn: {
          DEFAULT: '#F2B84B',
          bg: '#3A2B12',
        },
        crit: {
          DEFAULT: '#FF5C66',
          bg: '#3B151A',
        },
      },
      borderRadius: {
        card: '8px',
        control: '6px',
        pill: '999px',
      },
      boxShadow: {
        card: '0 1px 0 rgba(255,255,255,0.04), 0 12px 28px rgba(0,0,0,0.22)',
        drawer: '-18px 0 36px rgba(0,0,0,0.35)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        criticalPulse: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(255,92,102,0.35)' },
          '50%': { boxShadow: '0 0 0 6px rgba(255,92,102,0)' },
        },
        streamCaret: {
          '0%, 40%': { opacity: '1' },
          '41%, 100%': { opacity: '0' },
        },
        indeterminate: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(220%)' },
        },
      },
      animation: {
        'critical-pulse': 'criticalPulse 1.2s ease-in-out infinite',
        'stream-caret': 'streamCaret 0.8s steps(1) infinite',
        indeterminate: 'indeterminate 1.2s ease-in-out infinite',
      },
    },
  },
};
```

---

## 6. Layout 規格

### 6.1 Desktop Layout

參考圖：`refs/layout.png`

| 區域 | 尺寸 | 內容 | 注意事項 |
| --- | --- | --- | --- |
| App shell | `100vw x 100vh` | 整體背景 `bg-base` | 不讓 body scroll；內部區域各自 scroll。 |
| Left sidebar | `240px` wide | product name、environment、machine groups、nav icons | 可縮到 72px collapsed。 |
| Top bar | `56px` high | search、connection status、mock frequency、backpressure meter、diagnose action | control 高度固定 32-36px。 |
| Main topology | fill remaining | node grid / topology canvas | 背景 `bg-inset`，可用細 grid。 |
| Right drawer | `380-440px` wide | Copilot | 開啟時 main area 重新排版，不遮住主要狀態。 |
| Bottom event strip | `120-160px` high，可選 | recent error logs | 若資訊太擠，可改為 drawer 內 tab。 |

### 6.2 Mobile Layout

| 區域 | 規格 |
| --- | --- |
| Sidebar | 收成 icon button + sheet。 |
| Top bar | 保留 connection status 與主要 action，搜尋可收進 icon。 |
| Topology | 單欄 card list，不強求完整 topology。 |
| Copilot | bottom sheet，高度 `70-85vh`。 |
| Event strip | 收成 collapsible section。 |

### 6.3 Grid / Topology 背景

建議 CSS：

```css
.topology-bg {
  background-color: #0E151B;
  background-image:
    linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px);
  background-size: 24px 24px;
}
```

---

## 7. Components

### 7.1 `AppLayout`

責任：

- 提供 sidebar、top bar、main、drawer slot。
- 管理 drawer open/close。
- 管理 mobile sheet。
- 接收 connection status。

Props：

```ts
type AppLayoutProps = {
  connectionStatus: 'connected' | 'reconnecting' | 'disconnected';
  drawerOpen: boolean;
};
```

狀態樣式：

| connectionStatus | 顏色 | label |
| --- | --- | --- |
| `connected` | `ok` | Connected |
| `reconnecting` | `warn` | Reconnecting |
| `disconnected` | `crit` | Disconnected |

### 7.2 `TopBar`

內容：

- search input
- connection status chip
- mock frequency segmented control 或 slider
- backpressure meter（`BackpressureBadge`）
- pause/resume stream icon button
- diagnose selected machine button

控制項規格：

| 控制項 | 元件 |
| --- | --- |
| 搜尋 | input + search icon |
| mock frequency | slider 或 segmented control |
| backpressure meter | `BackpressureBadge`（見 7.2.1） |
| pause/resume | icon button |
| diagnose | icon + text button，disabled when no selected machine |

#### 7.2.1 `BackpressureBadge`

把「rAF 批次提交」的效果變成畫面上看得見的數字——這是本專案最直接的賣點佐證（背壓量化）。

內容：

- 累積收到的 telemetry 訊息數（`receivedMessages`）。
- 累積渲染批次數（`renderedBatches`）。
- 兩者比值，例如 `41:1`。

Props：

```ts
type BackpressureBadgeProps = {
  receivedMessages: number;
  renderedBatches: number;
};
```

顯示格式建議：

```text
12,840 msgs · 312 frames · 41:1
```

樣式：

| 屬性 | 規格 |
| --- | --- |
| 容器 | `bg-elevated`、`radius-pill`、padding `4px 10px` |
| 文字 | `font-mono`、`text-xs`、`text-secondary` |
| 比值數字 | 用 `text-primary` 或 `accent` 強調，與前面 label 區隔 |
| 數字寬度 | mono + 千分位，避免高頻更新造成寬度跳動 |
| 更新節奏 | 跟著 store 更新即可；不要每筆 message 觸發重排（值本來就在 rAF 批次後才變） |
| tooltip | 滑過顯示「收到的訊息 vs 實際渲染批次；比值越高代表背壓越有效」 |

狀態與行為：

- ratio 計算：`renderedBatches > 0 ? round(receivedMessages / renderedBatches) : 0`。
- mobile：可只保留 `41:1` 比值，省略前面兩個絕對值。
- 不是錯誤指標，恆用中性色（`text-secondary` / `accent`），不要用 warn/crit。

### 7.3 `MachineNodeCard`

參考圖：`refs/node-states.png`

內容：

- machine id
- machine display name
- state badge / status light
- temperature
- vibration
- throughput
- error rate
- last updated
- diagnose icon button

尺寸：

| 屬性 | 建議 |
| --- | --- |
| min width | `220px` |
| min height | `148px` |
| padding | `12px` |
| radius | `radius-card` |
| border | `1px solid border-subtle` |

狀態：

| State | 視覺 |
| --- | --- |
| healthy | `bg-surface`、`border-subtle`、status light `ok` |
| warning | `bg-surface` + `warn-bg` subtle inset、status light `warn` |
| critical | `crit-bg` tint、status light `crit`、`animate-critical-pulse` |
| selected | border `accent` 2px，背景可用 `accent-bg` 低透明 |
| stale | opacity 0.55、顯示 `Stale` badge |
| hover | border `border-strong`，輕微上移 `translateY(-1px)` |

文字規則：

- machine id 使用 mono。
- telemetry value 使用 mono + `text-number`。
- 長 machine name 最多兩行。
- 數值區使用固定 grid，避免跳動造成 layout shift。

### 7.4 `StatusLight`

Props：

```ts
type StatusLightProps = {
  state: 'healthy' | 'warning' | 'critical';
  pulse?: boolean;
};
```

規格：

- 直徑 8-10px。
- critical 可 pulse，但 wrapper 尺寸固定。
- 必須有 `aria-label`。

### 7.5 `ProgressBar`

用途：

- BullMQ job progress。
- active 時支援 indeterminate。
- completed/failed 用 ok/crit。

Props：

```ts
type ProgressBarProps = {
  status: 'waiting' | 'active' | 'completed' | 'failed';
  value?: number;
};
```

樣式：

| Status | 視覺 |
| --- | --- |
| waiting | muted track + subtle accent |
| active | accent bar，可 indeterminate |
| completed | ok full bar |
| failed | crit full bar |

### 7.6 `SeverityBadge`

| Severity | Label | Classes |
| --- | --- | --- |
| `ok` | OK | `text-ok bg-ok-bg` |
| `warning` | Warning | `text-warn bg-warn-bg` |
| `critical` | Critical | `text-crit bg-crit-bg` |

規格：

- radius pill。
- padding `4px 8px`。
- font size `12px`。

### 7.7 `CopilotDrawer`

參考圖：`refs/copilot-drawer.png`

區塊：

1. Header：machine id、job id short、close button。
2. Status：job status chip + progress bar。
3. Streaming panel：token text + caret。
4. Final result：summary、severity、likely causes。
5. Evidence：telemetry/errorlog/maintenance snippets。
6. Suggested actions：checkbox list 或 action buttons。

狀態：

| State | UI |
| --- | --- |
| idle | 顯示 selected machine summary 與 Run diagnosis。 |
| active | progress bar、streaming panel、disable duplicate submit。 |
| completed | severity badge、result sections、cached badge if `cached:true`。 |
| failed | error message、Retry button。 |

Streaming panel 規格：

- 背景 `bg-inset`。
- max height `220-320px`。
- overflow auto。
- token append 時保持可讀，不強制每次跳到底，除非使用者沒有手動 scroll。
- caret 使用 `animate-stream-caret`。

Suggested actions：

- 每項可多行。
- icon 可用 checkbox / wrench / play。
- priority high 使用 warn/crit，但不要整排紅底。

### 7.8 `EventStrip`

用途：

- 顯示最近 error logs。
- 可在 desktop 下方，mobile 收成 collapsible。

內容：

- timestamp
- machine id
- severity
- short message

規格：

- 高度 `120-160px`。
- row height `32-40px`。
- timestamp 使用 mono。

---

## 8. Interaction States

### 8.1 Diagnosis Flow

```text
idle
  -> user clicks Diagnose
  -> waiting
  -> active
  -> streaming tokens
  -> completed | failed
```

UI 規則：

- active 時不要允許同一台 machine 重複送出。
- 可以允許切換 selected machine，但 drawer 要明確顯示目前 job 對應 machine。
- completed 後保留結果，直到使用者重新診斷或切換。
- cached result 要顯示 `Cached` badge。

### 8.2 Connection States

| State | UI |
| --- | --- |
| connected | top bar 顯示綠點與 Connected。 |
| reconnecting | 黃點 + Reconnecting，stream controls disabled。 |
| disconnected | 紅點 + Disconnected，保留最後資料但標示 stale。 |

### 8.3 Stale Data

判斷：

- `Date.now() - lastUpdated > 10_000`

UI：

- node opacity 0.55。
- 顯示 `Stale` badge。
- 不清空數值，避免畫面跳動。

---

## 9. File Mapping

建議落地檔案：

```text
apps/web/src/shared/components/AppLayout.vue
apps/web/src/shared/components/TopBar.vue
apps/web/src/shared/components/StatusLight.vue
apps/web/src/shared/components/ProgressBar.vue
apps/web/src/shared/components/SeverityBadge.vue
apps/web/src/shared/components/BackpressureBadge.vue
apps/web/src/domains/monitoring/components/MachineNodeCard.vue
apps/web/src/domains/monitoring/components/TopologyCanvas.vue
apps/web/src/domains/monitoring/stores/monitoring.store.ts
apps/web/src/domains/monitoring/composables/useHighFrequencyWs.ts
apps/web/src/domains/ai-copilot/components/CopilotDrawer.vue
apps/web/src/domains/ai-copilot/stores/copilot.store.ts
```

禁止：

- 在 component 裡寫 `style="color:#..."`。
- 為每個 component 發明自己的 warning red/yellow。
- 建立與本檔 token 不一致的 shadow/radius。

---

## 10. Accessibility

- icon-only button 必須有 `aria-label` 或 tooltip。
- 狀態不能只靠顏色，需有文字 label 或 aria label。
- critical pulse 不可過快，避免干擾。
- progress bar 要有 `aria-valuenow` 或 indeterminate 描述。
- drawer close 可用 Escape。
- keyboard focus ring 使用 `accent`，不可移除。

---

## 11. Screenshot 驗收

至少檢查：

| Viewport | 目的 |
| --- | --- |
| 1366 x 768 | 常見 laptop dashboard。 |
| 1440 x 900 | 桌面預設。 |
| 390 x 844 | mobile bottom sheet。 |
| 768 x 1024 | tablet / narrow desktop。 |

檢查項目：

- 文字不溢出。
- 按鈕內容不擠壓。
- drawer 不遮住 top bar。
- node card hover/selected 不造成 layout shift。
- critical pulse 不改變 card 尺寸。
- streaming panel scroll 正常。

---

## 12. 驗收清單

- [ ] `refs/layout.png` 存在。
- [ ] `refs/node-states.png` 存在。
- [ ] `refs/copilot-drawer.png` 存在。
- [ ] 本檔 token 與 Tailwind `theme.extend` 一致。
- [ ] shared components 使用 token，不硬寫散落 hex。
- [ ] `MachineNodeCard` 有 healthy/warning/critical/selected/stale/hover。
- [ ] `CopilotDrawer` 有 idle/active/completed/failed。
- [ ] desktop 與 mobile 無重疊、無溢出。
- [ ] UI 第一屏是監控台。
- [ ] 沒有使用 Argo CD 官方商標或素材。

---

## 13. 變更紀錄

- `v0.1`：原始 Claude Design bridge，使用可填 placeholder。
- `v0.2`：加入具體預設 token、desktop/mobile、component states。
- `v0.3`：整合為 Spec Kit 可用交接規格，補齊 file mapping、interaction states、accessibility、screenshot 驗收。


