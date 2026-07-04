import type { MachineState } from "@flow-gatekeeper/contracts";

/**
 * 機台 state → 具名 token 的**單一對照**（design-spec §7.3/§7.4、review 006）。
 *
 * 過去 healthy/warning/critical → 顏色 token 的對映在 StatusLight、MachineNodeCard、
 * EventStrip、FleetHealth 各自重寫一份；改一個 token 要同時改四處，漏一處就某面板顏色不一致。
 * 此處集中，各元件一律消費，改色只改這一處。位於 shared/lib（跨 domain 共用、domain-agnostic）。
 */
export interface StateStyle {
  /** 可讀標籤，如 "Healthy"（縮寫如 "WARN" 由呈現層自理）。 */
  label: string;
  /** 實心點/比例條/legend 圓點色（bg-*）。 */
  dot: string;
  /** 徽章文字色（text-*-fg）。 */
  badgeText: string;
  /** 徽章底色（bg-*-bg）。 */
  badgeSurface: string;
}

export const STATE_STYLE: Record<MachineState, StateStyle> = {
  healthy: { label: "Healthy", dot: "bg-ok", badgeText: "text-ok-fg", badgeSurface: "bg-ok-bg" },
  warning: { label: "Warning", dot: "bg-warn", badgeText: "text-warn-fg", badgeSurface: "bg-warn-bg" },
  critical: { label: "Critical", dot: "bg-crit", badgeText: "text-crit-fg", badgeSurface: "bg-crit-bg" },
};

/** stale 為聚合層第四類（非機台 state），用中性 strong 色。 */
export const STALE_DOT = "bg-strong";
