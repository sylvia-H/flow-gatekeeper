import type { TelemetryPoint } from "@flow-gatekeeper/contracts";

export interface CoalesceResult {
  /** 保留下來、依原到達順序排列的資料點。 */
  kept: TelemetryPoint[];
  /** 被捨棄的筆數（＝輸入長度 − kept 長度），供 store 的 droppedMessages 計數。 */
  dropped: number;
}

/**
 * buffer 溢位時的合併策略：保留「每台最新一筆」與「state 轉換點」，丟掉中間同態的重複值。
 *
 * 為什麼不直接截斷最舊：背景分頁（rAF 停擺）或 Pause 超過一段時間後，單純截斷會把期間的
 * 狀態轉換整段丟掉，Event Stream 永遠看不到那次 warning/critical。卡片只顯示最新值、事件只在
 * 轉換點衍生，所以同一台連續同態的中間點對畫面沒有貢獻，是最便宜的犧牲品。
 *
 * 每台保留：第一筆（它相對 store 現有快照可能就是一次轉換，composable 無從得知）、每個
 * state 改變的點、最後一筆。合併後每台的「state 序列去除連續重複」與原序列完全相同，
 * 因此 store 衍生的事件不受影響（只是遙測數值被取樣）。
 *
 * 若合併後仍超過上限（多台長時間高頻抖動，屬病態情況），從最舊的非「最新一筆」開始丟，
 * 並一次降到 `lowWater`：留出空間，避免之後每收一則訊息都要重跑一次 O(n) 合併。
 */
export function coalesceTelemetry(
  points: readonly TelemetryPoint[],
  maxSize: number,
  lowWater = Math.floor(maxSize / 2),
): CoalesceResult {
  const lastIndex = new Map<string, number>();
  points.forEach((p, i) => lastIndex.set(p.machineId, i));

  const prevState = new Map<string, TelemetryPoint["state"]>();
  const keptIdx: number[] = [];
  points.forEach((p, i) => {
    const prev = prevState.get(p.machineId);
    const isFirst = prev === undefined;
    const isTransition = !isFirst && prev !== p.state;
    const isLatest = lastIndex.get(p.machineId) === i;
    if (isFirst || isTransition || isLatest) keptIdx.push(i);
    prevState.set(p.machineId, p.state);
  });

  let finalIdx = keptIdx;
  if (keptIdx.length > maxSize) {
    const target = Math.max(lowWater, lastIndex.size);
    let excess = keptIdx.length - target;
    finalIdx = keptIdx.filter((i) => {
      if (excess > 0 && lastIndex.get(points[i]!.machineId) !== i) {
        excess -= 1;
        return false;
      }
      return true;
    });
    // 機台數本身就超過上限（理論上不會發生）時才退回截斷最舊。
    if (finalIdx.length > maxSize) finalIdx = finalIdx.slice(finalIdx.length - maxSize);
  }

  const kept = finalIdx.map((i) => points[i]!);
  return { kept, dropped: points.length - kept.length };
}
