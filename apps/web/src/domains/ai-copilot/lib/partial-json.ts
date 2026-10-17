import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import type { EvidenceItem } from "./evidence-merge.js";

/**
 * 串流漸進解析（research R6、data-model §9）：把 `active` 態累積的 `streamText`（尚未完成的 JSON 文字）
 * 容錯解析成「每欄位各自 missing／streaming／complete」的呈現用結構，供面板在串流中逐欄長出內容。
 *
 * **僅供 `active` 串流態呈現**（工程硬規則 6）：PartialResult 不是診斷結果，未經
 * `DiagnosisResultSchema.parse()` 驗證，MUST NOT 當作正式結果使用或寫入任何狀態。完成態一律改用
 * `ai/done` 經 schema 驗證的 `result`；失敗態以 `raw`（原始串流）呈現中斷前推理。本檔刻意不提供
 * 「PartialResult → DiagnosisResult」的轉換。
 *
 * 演算法（O(n)，幾 KB 文字不需節流）：
 * 1. 從第一個 `{` 起取子字串，前綴雜訊（說明文字、```json 圍欄）丟掉；
 * 2. 單趟掃描追蹤字串／跳脫／括號堆疊與「物件內正在讀 key 還是 value」，並記錄可安全截斷的位置
 *    （容器開頭之後、每個完整 value 之後）；
 * 3. 根物件已閉合 → 直接 `JSON.parse`（尾端雜訊如 ``` 忽略）；未閉合（截斷）→ 若截斷在 value 字串內，
 *    去掉未完成的跳脫序列後補上引號與所有未閉合括號；否則退回最後一個安全位置再補括號
 *    （懸空的逗號、`"key":` 後無值、截斷的 key 或數字／字面值都會被一併丟掉）；
 * 4. 寬鬆讀取五欄位：只取存在且型別正確者；陣列中型別不對的元素丟掉；
 * 5. 任一步失敗 → 五欄全部 `missing`，`raw` 仍保留原文。
 *
 * 欄位狀態：欄位不存在（或型別不符）→ `missing`；截斷點落在該 top-level 欄位的 value 內 → `streaming`；
 * 其餘 → `complete`。
 */

export type DiagnosisSeverity = DiagnosisResult["severity"];
export type SuggestedAction = DiagnosisResult["suggestedActions"][number];
export type PartialFieldState = "missing" | "streaming" | "complete";

export interface PartialField<T> {
  value: T;
  state: PartialFieldState;
}

export interface PartialResult {
  fields: {
    summary: PartialField<string>;
    /** missing 時為 `null`；streaming 中尚未拼出合法等級（如 `"warn`）時也為 `null`。 */
    severity: PartialField<DiagnosisSeverity | null>;
    likelyCauses: PartialField<string[]>;
    evidence: PartialField<EvidenceItem[]>;
    suggestedActions: PartialField<SuggestedAction[]>;
  };
  /** 原文（供「原始串流」展開）；永遠是傳入的完整 `text`。 */
  raw: string;
}

type FieldKey = keyof PartialResult["fields"];

const SEVERITY_SCHEMA = DiagnosisResultSchema.shape.severity;
const EVIDENCE_ITEM_SCHEMA = DiagnosisResultSchema.shape.evidence.element;
const ACTION_ITEM_SCHEMA = DiagnosisResultSchema.shape.suggestedActions.element;

function allMissing(raw: string): PartialResult {
  return {
    fields: {
      summary: { value: "", state: "missing" },
      severity: { value: null, state: "missing" },
      likelyCauses: { value: [], state: "missing" },
      evidence: { value: [], state: "missing" },
      suggestedActions: { value: [], state: "missing" },
    },
    raw,
  };
}

interface Frame {
  kind: "{" | "[";
  /** 僅物件用：下一個字串是 key（`{` 或 `,` 之後）。 */
  expectKey: boolean;
}

interface ScanOutcome {
  /** 修補後可 `JSON.parse` 的候選字串（依優先順序）。 */
  candidates: string[];
  /** 截斷點所在的 top-level key（截斷在其 value 內時才有值）。 */
  truncatedKey: string | null;
  /** 截斷點是否落在 top-level 陣列的某個物件元素內（該元素不完整，要丟掉）。 */
  inArrayObjectElement: boolean;
}

const closersOf = (stack: readonly Frame[]): string =>
  stack
    .map((f) => (f.kind === "{" ? "}" : "]"))
    .reverse()
    .join("");

/** 解碼 key 字串字面值；含非法字元（如未跳脫的換行）時回 null，該 key 不會被標成 streaming。 */
function decodeKey(literal: string): string | null {
  try {
    const v: unknown = JSON.parse(literal);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function scan(s: string): ScanOutcome {
  const stack: Frame[] = [];
  let inString = false;
  let stringIsKey = false;
  let stringStart = -1;
  /** 進行中跳脫序列的起點（`\` 的位置），-1 表示不在跳脫中。 */
  let escStart = -1;
  /** `\uXXXX` 尚缺的十六進位位數。 */
  let hexLeft = 0;
  /** 最後一個安全截斷點：`s.slice(0, safeEnd) + safeClosers` 為合法 JSON。 */
  let safeEnd = -1;
  let safeClosers = "";
  /** depth 1（根物件）最近讀到的 key，以及其 value 是否已開始。 */
  let topKey: string | null = null;
  let topValueStarted = false;

  const markSafe = (end: number): void => {
    safeEnd = end;
    safeClosers = closersOf(stack);
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inString) {
      if (escStart >= 0) {
        if (hexLeft > 0) {
          hexLeft--;
          if (hexLeft === 0) escStart = -1;
        } else if (ch === "u") {
          hexLeft = 4;
        } else {
          escStart = -1;
        }
        continue;
      }
      if (ch === "\\") {
        escStart = i;
        continue;
      }
      if (ch === '"') {
        inString = false;
        const top = stack[stack.length - 1];
        if (stringIsKey) {
          if (top) top.expectKey = false;
          if (stack.length === 1) {
            topKey = decodeKey(s.slice(stringStart, i + 1));
            topValueStarted = false;
          }
        } else {
          markSafe(i + 1);
        }
      }
      continue;
    }
    const top = stack[stack.length - 1];
    switch (ch) {
      case '"':
        inString = true;
        stringStart = i;
        stringIsKey = top?.kind === "{" && top.expectKey;
        if (!stringIsKey && stack.length === 1) topValueStarted = true;
        break;
      case "{":
      case "[":
        if (stack.length === 1) topValueStarted = true;
        stack.push({ kind: ch, expectKey: ch === "{" });
        markSafe(i + 1);
        break;
      case "}":
      case "]":
        stack.pop();
        if (stack.length === 0) {
          return {
            candidates: [s.slice(0, i + 1)],
            truncatedKey: null,
            inArrayObjectElement: false,
          };
        }
        markSafe(i + 1);
        break;
      case ",":
        // 逗號前的 value 已完整（含數字／字面值）：安全點落在逗號之前。
        markSafe(i);
        if (top?.kind === "{") top.expectKey = true;
        break;
      default:
        if (stack.length === 1 && topKey !== null && ch !== ":" && !/\s/.test(ch)) {
          topValueStarted = true;
        }
    }
  }

  if (stack.length === 0) {
    return { candidates: [], truncatedKey: null, inArrayObjectElement: false };
  }

  const candidates: string[] = [];
  const inValueString = inString && !stringIsKey;
  if (inValueString) {
    // 截斷在 value 字串內：保留已到的文字，去掉未完成的跳脫序列後補引號與括號。
    const body = escStart >= 0 ? s.slice(0, escStart) : s;
    candidates.push(`${body}"${closersOf(stack)}`);
  }
  if (safeEnd >= 0) candidates.push(s.slice(0, safeEnd) + safeClosers);

  // 截斷在 top-level value 內：深度 ≥ 2（陣列／物件內），或在根物件的 value 字串內。
  const insideTopValue = stack.length >= 2 || (stack.length === 1 && inValueString);
  return {
    candidates,
    truncatedKey: insideTopValue && topValueStarted ? topKey : null,
    // 根物件 → top-level 陣列 → 物件元素：深度 ≥ 3 且第三層是物件。
    inArrayObjectElement: stack.length >= 3 && stack[1]?.kind === "[" && stack[2]?.kind === "{",
  };
}

function tryParseObject(candidates: readonly string[]): Record<string, unknown> | null {
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
    } catch {
      // 換下一個候選
    }
  }
  return null;
}

/** 把 PartialResult 的串流文字解析為每欄位狀態；**僅供 `active` 串流態呈現**，見檔頭說明。 */
export function parsePartialDiagnosis(text: string): PartialResult {
  const start = text.indexOf("{");
  if (start < 0) return allMissing(text);

  const outcome = scan(text.slice(start));
  const obj = tryParseObject(outcome.candidates);
  if (!obj) return allMissing(text);

  const result = allMissing(text);
  const stateOf = (key: FieldKey): PartialFieldState =>
    outcome.truncatedKey === key ? "streaming" : "complete";
  const has = (key: FieldKey): boolean => Object.prototype.hasOwnProperty.call(obj, key);

  if (has("summary") && typeof obj.summary === "string") {
    result.fields.summary = { value: obj.summary, state: stateOf("summary") };
  }

  if (has("severity")) {
    const parsed = SEVERITY_SCHEMA.safeParse(obj.severity);
    const state = stateOf("severity");
    if (parsed.success) {
      result.fields.severity = { value: parsed.data, state };
    } else if (state === "streaming" && typeof obj.severity === "string") {
      // 等級字串還沒拼完（如 "warn"）：欄位在串流中，但尚無合法值。
      result.fields.severity = { value: null, state };
    }
  }

  if (has("likelyCauses") && Array.isArray(obj.likelyCauses)) {
    result.fields.likelyCauses = {
      // 字串元素：最後一個截斷中的字串照樣保留，讓文字逐字長出。
      value: obj.likelyCauses.filter((x): x is string => typeof x === "string"),
      state: stateOf("likelyCauses"),
    };
  }

  const readObjectArray = <T>(
    key: "evidence" | "suggestedActions",
    parseItem: (x: unknown) => T | null,
  ): PartialField<T[]> | null => {
    const arr = obj[key];
    if (!has(key) || !Array.isArray(arr)) return null;
    const state = stateOf(key);
    // 物件元素：截斷中的最後一個元素不完整（excerpt／command 可能只到一半），整個丟掉。
    const items = state === "streaming" && outcome.inArrayObjectElement ? arr.slice(0, -1) : arr;
    const value: T[] = [];
    for (const x of items) {
      const item = parseItem(x);
      if (item !== null) value.push(item);
    }
    return { value, state };
  };

  const evidence = readObjectArray("evidence", (x) => {
    const r = EVIDENCE_ITEM_SCHEMA.safeParse(x);
    return r.success ? r.data : null;
  });
  if (evidence) result.fields.evidence = evidence;

  const actions = readObjectArray("suggestedActions", (x) => {
    const r = ACTION_ITEM_SCHEMA.safeParse(x);
    return r.success ? r.data : null;
  });
  if (actions) result.fields.suggestedActions = actions;

  return result;
}
