import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import type { CopilotJobState } from "./copilot-reducer.js";
import { severityLabel } from "../../../shared/lib/severity-label.js";

/**
 * 診斷狀態 chip（data-model §7、FR-028）：由每台 `CopilotJobState` 衍生、不另存。
 * `none` 也帶 `kind`，消費端（拓樸卡片、手機 peek 條）一律以 `badge.kind` 分派並輸出 `data-diagnosis`。
 * 全部為純函式；copilot store 的 `badgeFor` 以 computed 套用 `diagnosisBadgeOf`。
 */
export type DiagnosisBadge =
  | { kind: "none" }
  | { kind: "active"; progress: number | null }
  | { kind: "completed"; severity: DiagnosisResult["severity"]; cached: boolean }
  | { kind: "failed" };

/** 無診斷（idle 或從未診斷）的共用值：同一個物件，未診斷的卡片 props 不因重算而換身分。 */
export const NO_DIAGNOSIS_BADGE: DiagnosisBadge = Object.freeze({ kind: "none" });

/** 單台狀態 → chip。 */
export function diagnosisBadgeOf(state: CopilotJobState | undefined): DiagnosisBadge {
  switch (state?.status) {
    case "active":
      return { kind: "active", progress: state.progress };
    case "completed":
      return { kind: "completed", severity: state.result.severity, cached: state.cached };
    case "failed":
      return { kind: "failed" };
    default:
      return NO_DIAGNOSIS_BADGE;
  }
}

/** 兩個 chip 的呈現是否相同（欄位逐一比對）。 */
export function sameDiagnosisBadge(a: DiagnosisBadge, b: DiagnosisBadge): boolean {
  switch (a.kind) {
    case "active":
      return b.kind === "active" && a.progress === b.progress;
    case "completed":
      return b.kind === "completed" && a.severity === b.severity && a.cached === b.cached;
    default:
      return a.kind === b.kind;
  }
}

/**
 * chip 的可見文案：「診斷中 60%」（尚無進度為「診斷中」）／「AI：嚴重」（完成）／「AI：正常 · 快取」（快取命中）／「AI 失敗」；
 * 無診斷回 null（不渲染）。嚴重度譯名取自 `severityLabel`。
 * 「AI：」前綴（T073 第四輪）：同一張卡上狀態徽章（現在）、異常標記（過去，已回復者以「曾」起頭）與本 chip（AI 判定）
 * 原本同為「正常／警告／嚴重」同字同形；前綴兩字就交代「這是 AI 的判定」，220px 卡寬的 id 列仍放得下
 * （第三輪拿掉的「結果 ·」前綴比它長）。快取標記放在嚴重度之後：空間不足時先讀到的仍是判定本身。
 * 可讀名稱前綴「診斷：」由呈現端加上。
 */
export function diagnosisBadgeText(badge: DiagnosisBadge): string | null {
  switch (badge.kind) {
    case "active":
      return badge.progress === null ? "診斷中" : `診斷中 ${badge.progress}%`;
    case "completed":
      return badge.cached ? `AI：${severityLabel(badge.severity)} · 快取` : `AI：${severityLabel(badge.severity)}`;
    case "failed":
      return "AI 失敗";
    default:
      return null;
  }
}
