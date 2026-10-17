/**
 * US7 Drawer active 步驟清單（data-model §5、research R11）。純函式：由既有
 * `CopilotJobState.progress` 衍生里程碑步驟狀態，不新增事件/契約。
 * 里程碑沿用 005 FR-018（0/20/40/60/80/100）；標籤為介面文案、一律繁體中文（013 FR-038），
 * 不夾 context／token 等英文字。
 */
export type StepStatus = "done" | "active" | "todo";
export type Milestone = 0 | 20 | 40 | 60 | 80 | 100;

export interface JobStep {
  milestone: Milestone;
  label: string;
  status: StepStatus;
}

const MILESTONES: readonly { milestone: Milestone; label: string }[] = [
  { milestone: 0, label: "任務啟動" },
  { milestone: 20, label: "彙整診斷資料" },
  { milestone: 40, label: "取得去重鎖" },
  { milestone: 60, label: "收到首段串流" },
  { milestone: 80, label: "解析結果成功" },
  { milestone: 100, label: "寫入並完成" },
];

/**
 * 依當前 `progress` 標記每步：
 * - `milestone < progress` → done（已越過）。
 * - 當前所在里程碑（`progress` 命中的里程碑，或往上最近的未越過里程碑）→ active。
 * - 其餘 → todo。
 * `progress` 為 `null`/`undefined`（indeterminate）→ 首步 active、其餘 todo。
 */
export function jobSteps(progress: number | null | undefined): JobStep[] {
  if (progress === null || progress === undefined) {
    return MILESTONES.map((m, index) => ({
      milestone: m.milestone,
      label: m.label,
      status: index === 0 ? "active" : "todo",
    }));
  }
  const activeMilestone = MILESTONES.find((m) => m.milestone >= progress)?.milestone;
  return MILESTONES.map((m) => {
    let status: StepStatus;
    if (m.milestone < progress) status = "done";
    else if (m.milestone === activeMilestone) status = "active";
    else status = "todo";
    return { milestone: m.milestone, label: m.label, status };
  });
}
