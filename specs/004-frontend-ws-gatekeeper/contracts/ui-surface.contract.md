# Contract — UI 元件介面（引用 design-spec 為 SoT）

**單一真實來源**：`apps/web/design/design-spec.md`（§4 tokens、§6 layout、§7 components、§8 interaction、§10 accessibility、§11 screenshot 驗收）。本檔**不重述** token/尺寸/色值，只固定本 feature 要交付的元件 **props 與 states 契約**，並標註對應 design-spec 條目與 spec FR。範圍限 004；`ProgressBar`/`SeverityBadge`/`CopilotDrawer`/`EventStrip` 屬 005，不在此。

## `AppLayout`（design-spec §7.1）
```ts
type AppLayoutProps = { connectionStatus: 'connected'|'reconnecting'|'disconnected'; drawerOpen: boolean }
```
- slot：sidebar / top bar / main / drawer。004 的 drawer slot 先留空（005 填 CopilotDrawer）。FR-001（第一屏監控台）、FR-015（三態）。

## `TopBar`（design-spec §7.2）
- 內容：search input（外觀）、connection status chip、`BackpressureBadge`、diagnose 按鈕（**disabled 佔位**，實際觸發屬 005）。
- connection chip 顏色/label 依 §7.1 表（connected→ok / reconnecting→warn / disconnected→crit）。FR-015。

## `BackpressureBadge`（design-spec §7.2.1）
```ts
type BackpressureBadgeProps = { receivedMessages: number; renderedBatches: number }
```
- 顯示：`12,840 msgs · 312 frames · 41:1`（mono、千分位、中性色）；ratio = `renderedBatches>0 ? round(received/rendered) : 0`。
- MUST 中性色（非 warn/crit）、tooltip 說明背壓意義。FR-009~011、SC-002。

## `StatusLight`（design-spec §7.4）
```ts
type StatusLightProps = { state: 'healthy'|'warning'|'critical'; pulse?: boolean }
```
- 直徑 8–10px；critical 可 pulse（wrapper 尺寸固定，不造 layout shift）；MUST 有 `aria-label`。FR-007、FR-008、FR-020、§10。

## `MachineNodeCard`（design-spec §7.3、refs/node-states.png）
```ts
type MachineNodeCardProps = {
  machine: MachineLive | null   // null = placeholder（冷啟動/首批未到）
  machineId: string             // placeholder 也需 id 以顯示卡片
  selected: boolean
  stale: boolean
}
// emits: (e:'select', machineId: string)
```
- 呈現：machineId（mono）、`machineLabel(machineId)`、`StatusLight(state)`、溫/振/吞/錯（mono、`text-number`、固定 grid）、lastUpdated。FR-006、FR-006a。
- states：healthy/warning/critical/selected/stale/hover（§7.3 表）；critical 用 `animate-critical-pulse`；selected 用 accent 邊框；stale opacity 0.55 + `Stale` badge **且不清空數值**。FR-016、FR-017、FR-023。
- placeholder（`machine===null`）：數值以 `—` 佔位、狀態燈中性、不報錯。FR-024、SC 首屏不跳動。
- 點選 → `emit('select', machineId)` → `store.selectMachine`。FR-023。

## `TopologyCanvas`（design-spec §6.3）
- node grid 容器（`topology-bg`），`v-for` `store.machineList` 渲染 `MachineNodeCard`；responsive：desktop grid、mobile 單欄 list。MUST 不溢出/不重疊/hover 不 layout shift。FR-020、SC-004。

## 無障礙（design-spec §10，對應 FR-021）
- icon-only 控制項 MUST 有 `aria-label` 或 tooltip；狀態不只靠顏色（附文字/aria）；keyboard focus ring 用 accent、不可移除；critical pulse 不過快。
