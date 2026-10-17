import type { MachineState } from "@flow-gatekeeper/contracts";

/**
 * 機台 state → 語意 token 的**單一對照**（013 ui-contract §1、research R13 術語；源自 review 006）。
 *
 * 過去 healthy/warning/critical → 顏色 token 的對映在 StatusLight、MachineNodeCard、
 * EventStrip、FleetHealth 各自重寫一份；改一個 token 要同時改四處，漏一處就某面板顏色不一致。
 * 此處集中，各元件一律消費，改色只改這一處。位於 shared/lib（跨 domain 共用、domain-agnostic）。
 */
export interface StateStyle {
  /** 可讀標籤（繁中：正常／警告／嚴重，research R13）。 */
  label: string;
  /** 實心點/比例條/legend 圓點色（bg-*）。 */
  dot: string;
  /** 徽章文字色（text-*-fg）。 */
  badgeText: string;
  /** 徽章底色（bg-*-bg）。 */
  badgeSurface: string;
}

export const STATE_STYLE: Record<MachineState, StateStyle> = {
  healthy: { label: "正常", dot: "bg-ok", badgeText: "text-ok-fg", badgeSurface: "bg-ok-bg" },
  warning: { label: "警告", dot: "bg-warn", badgeText: "text-warn-fg", badgeSurface: "bg-warn-bg" },
  critical: { label: "嚴重", dot: "bg-crit", badgeText: "text-crit-fg", badgeSurface: "bg-crit-bg" },
};

/** stale（停滯）為聚合層第四類（非機台 state），用 `stale` token；卡片與聚合面板統一（FR-004）。 */
export const STALE_DOT = "bg-stale";
