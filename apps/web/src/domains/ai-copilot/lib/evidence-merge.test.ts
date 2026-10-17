import { describe, expect, it } from "vitest";
import { mergeEvidence, normalizeExcerpt, splitPreview, type EvidenceItem } from "./evidence-merge.js";

describe("normalizeExcerpt", () => {
  it("去首尾與連續空白、轉小寫", () => {
    expect(normalizeExcerpt("  Temp   92°C \n High ")).toBe("temp 92°c high");
  });

  it("去 […] 時間戳樣式", () => {
    expect(normalizeExcerpt("[2026-10-15T10:00:00Z] Fan stalled")).toBe("fan stalled");
    expect(normalizeExcerpt("Fan stalled [10:00:01]")).toBe("fan stalled");
    expect(normalizeExcerpt("a[1]b")).toBe("a b");
  });

  it("只有時間戳或空白 → 空字串", () => {
    expect(normalizeExcerpt("  [10:00:01]  ")).toBe("");
    expect(normalizeExcerpt("")).toBe("");
  });
});

describe("mergeEvidence", () => {
  it("大小寫與空白差異合併；excerpt 取第一筆原文；count 累加", () => {
    const items: EvidenceItem[] = [
      { source: "errorlog", excerpt: "Fan  Stalled" },
      { source: "errorlog", excerpt: " fan stalled " },
      { source: "errorlog", excerpt: "FAN STALLED" },
    ];
    expect(mergeEvidence(items)).toEqual([
      { source: "errorlog", excerpt: "Fan  Stalled", key: "errorlog|fan stalled", count: 3 },
    ]);
  });

  it("時間戳樣式差異合併", () => {
    const groups = mergeEvidence([
      { source: "telemetry", excerpt: "[10:00:01] temp 92°C" },
      { source: "telemetry", excerpt: "[10:00:05] temp 92°C" },
      { source: "telemetry", excerpt: "temp 92°C [2026-10-15T10:00:09Z]" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ excerpt: "[10:00:01] temp 92°C", count: 3 });
  });

  it("不同 source 不合併", () => {
    const groups = mergeEvidence([
      { source: "telemetry", excerpt: "overheat" },
      { source: "errorlog", excerpt: "overheat" },
    ]);
    expect(groups.map((g) => [g.source, g.count])).toEqual([
      ["telemetry", 1],
      ["errorlog", 1],
    ]);
  });

  it("正規化後為空的 excerpt 不合併，各自成列且 key 唯一", () => {
    const groups = mergeEvidence([
      { source: "maintenance", excerpt: "" },
      { source: "maintenance", excerpt: "  " },
      { source: "maintenance", excerpt: "[10:00:01]" },
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.count === 1)).toBe(true);
    expect(groups.map((g) => g.key)).toEqual([
      "maintenance|#EMPTY-0",
      "maintenance|#EMPTY-1",
      "maintenance|#EMPTY-2",
    ]);
  });

  it("空 excerpt 的大寫標記不會與一般 key 相撞（一般 key 已轉小寫）", () => {
    const groups = mergeEvidence([
      { source: "maintenance", excerpt: "" },
      { source: "maintenance", excerpt: "#EMPTY-0" },
    ]);
    expect(groups.map((g) => g.key)).toEqual(["maintenance|#EMPTY-0", "maintenance|#empty-0"]);
  });

  it("依首次出現順序；不帶時間欄位", () => {
    const groups = mergeEvidence([
      { source: "telemetry", excerpt: "A" },
      { source: "errorlog", excerpt: "B" },
      { source: "telemetry", excerpt: "a" },
      { source: "maintenance", id: "m-1", excerpt: "C" },
    ]);
    expect(groups.map((g) => [g.excerpt, g.count])).toEqual([
      ["A", 2],
      ["B", 1],
      ["C", 1],
    ]);
    expect(Object.keys(groups[0] ?? {}).sort()).toEqual(["count", "excerpt", "key", "source"]);
  });

  it("不改動輸入", () => {
    const items: EvidenceItem[] = [{ source: "telemetry", excerpt: "x" }, { source: "telemetry", excerpt: "X" }];
    const snapshot = structuredClone(items);
    mergeEvidence(items);
    expect(items).toEqual(snapshot);
  });

  it("空輸入回空陣列", () => {
    expect(mergeEvidence([])).toEqual([]);
  });
});

describe("splitPreview", () => {
  const groups = mergeEvidence(
    ["a", "b", "c", "d", "e"].map((excerpt) => ({ source: "telemetry" as const, excerpt })),
  );

  it("預設前 2 筆預覽，剩餘列表與數量", () => {
    const { preview, rest } = splitPreview(groups);
    expect(preview.map((g) => g.excerpt)).toEqual(["a", "b"]);
    expect(rest.map((g) => g.excerpt)).toEqual(["c", "d", "e"]);
    expect(rest.length).toBe(3);
  });

  it("不足 n 筆：全部預覽、rest 空", () => {
    const { preview, rest } = splitPreview(groups.slice(0, 1));
    expect(preview).toHaveLength(1);
    expect(rest).toEqual([]);
  });

  it("自訂 n", () => {
    expect(splitPreview(groups, 4).rest).toHaveLength(1);
    expect(splitPreview(groups, 0).preview).toEqual([]);
  });
});
