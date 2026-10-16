import type { MachineGroup, MachineGroupName, StageKey } from "./machine-groups.js";

/**
 * stage 拓樸版面（data-model §4、FR-003）。分組來源為 `MACHINE_GROUPS`（前端單一來源），不另寫名冊。
 */
export interface Stage {
  name: MachineGroupName;
  key: StageKey;
  /** stage 繁中顯示名。 */
  label: string;
  /** 本欄可見機台，順序依分組定義（未分組者接在最後一欄末尾）。 */
  machineIds: readonly string[];
  /** 欄序（0 起算，依 groups 順序；三組時為 0／1／2）。 */
  order: number;
}

/** 已警告過的未分組 id：每個未知 id 在整個 process 只警告一次（computed 每幀重算也不洗版）。 */
const warnedIds = new Set<string>();

/** 測試用：清空已警告名單，讓各測試案例可重用同一個未知 id 而不互相影響。 */
export function resetStageWarnings(): void {
  warnedIds.clear();
}

/**
 * 把可見機台（搜尋過濾後）分到各 stage 欄：
 * - 依 `groups` 順序回**每一欄**（搜尋後某欄為空仍保留為空陣列，版面不跳）；
 * - 欄內順序依分組定義，不依 `visibleIds` 順序；
 * - 不在任何分組的 id 歸入最後一欄末尾（依 `visibleIds` 順序），並對每個這樣的 id `console.warn` 一次。
 */
export function assignToStages(
  visibleIds: readonly string[],
  groups: readonly MachineGroup[],
): Stage[] {
  const visible = new Set(visibleIds);
  const grouped = new Set(groups.flatMap((g) => g.machineIds));
  const stages: Stage[] = groups.map((group, order) => ({
    name: group.name,
    key: group.key,
    label: group.label,
    machineIds: group.machineIds.filter((id) => visible.has(id)),
    order,
  }));
  const ungrouped = visibleIds.filter((id) => !grouped.has(id));
  const last = stages.at(-1);
  if (ungrouped.length === 0 || last === undefined) return stages;
  for (const id of ungrouped) {
    if (warnedIds.has(id)) continue;
    warnedIds.add(id);
    console.warn(`[stage-layout] 機台 ${id} 不在任何分組，暫歸入最後一欄「${last.label}」`);
  }
  last.machineIds = [...last.machineIds, ...ungrouped];
  return stages;
}
