import type { DiagnosisResult } from "@flow-gatekeeper/contracts";

/**
 * 證據合併（spec FR-021、data-model §12、research R6 附）：evidence 契約只有 `source`、`id?`、`excerpt`，
 * 沒有時間欄位，故以 `source` + 正規化 `excerpt` 為合併鍵，只呈現 `×N`、不帶時間。純函式、不就地改。
 */

export type EvidenceItem = DiagnosisResult["evidence"][number];
export type EvidenceSource = EvidenceItem["source"];

export interface EvidenceGroup {
  source: EvidenceSource;
  /** 第一筆的原文（顯示用）。 */
  excerpt: string;
  /** `source + "|" + normalizeExcerpt(excerpt)`；正規化後為空者改用 `source + "|#EMPTY-" + 序號`（大寫標記：正規化會轉小寫，一般 key 不可能撞上），確保各自成列且 key 唯一。 */
  key: string;
  /** 合併筆數（≥ 1），顯示為 `×N`。 */
  count: number;
}

/**
 * 時間戳樣式：任何 `[…]` 方括號片段（如 `[2026-10-15T10:00:00Z]`、`[10:00:01]`）。
 * 刻意寬鬆——不驗證括號內是否真的是時間，log 中的 `[INFO]` 這類標籤也會一併去掉，對「判斷是否同一則證據」無害。
 */
const BRACKETED = /\[[^\]]*\]/g;

/** 正規化 excerpt：去 `[…]` 時間戳樣式、連續空白壓成一個、去首尾空白、轉小寫。 */
export function normalizeExcerpt(s: string): string {
  return s.replace(BRACKETED, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 合併證據：`source` 相同且正規化 `excerpt` 相同者併為一筆（`count` 累加、`excerpt` 取第一筆原文）；
 * 正規化後為空字串者不合併（各自成列、`count` 1）；輸出依首次出現順序。
 */
export function mergeEvidence(items: readonly EvidenceItem[]): EvidenceGroup[] {
  const groups: EvidenceGroup[] = [];
  const byKey = new Map<string, EvidenceGroup>();
  let emptySeq = 0;
  for (const item of items) {
    const normalized = normalizeExcerpt(item.excerpt);
    if (normalized === "") {
      groups.push({ source: item.source, excerpt: item.excerpt, key: `${item.source}|#EMPTY-${emptySeq++}`, count: 1 });
      continue;
    }
    const key = `${item.source}|${normalized}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    const group: EvidenceGroup = { source: item.source, excerpt: item.excerpt, key, count: 1 };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

/** 預設展開前 `n` 列，其餘收在「還有 N 筆」（N = `rest.length`）之後。 */
export function splitPreview(
  groups: readonly EvidenceGroup[],
  n = 2,
): { preview: EvidenceGroup[]; rest: EvidenceGroup[] } {
  const k = Math.max(0, Math.floor(n));
  return { preview: groups.slice(0, k), rest: groups.slice(k) };
}
