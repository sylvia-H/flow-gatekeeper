import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import asyncapiRaw from "../../../asyncapi.yaml?raw";
import changelogRaw from "../../../CHANGELOG.md?raw";
import readmeRaw from "../../../README.md?raw";
import guideRaw from "../../../docs/Flow-Gatekeeper-SDD-完整實作指南.md?raw";

/**
 * 文件中的契約版本宣稱必須等於 `asyncapi.yaml` 的 `info.version`（審查報告 review02 §6 Batch C 第 8 項）。
 *
 * 升契約版本時最常漏的是 README／指南／CHANGELOG 裡的版本字串；Spectral 與漂移測試都不看 Markdown，
 * 這裡補一道便宜的字串比對。contracts 不依賴 `@types/node`，故沿用漂移測試的 vite `?raw` 匯入。
 * `CHANGELOG.md` 是憲章／CLAUDE.md 規定 MUST 存在的檔案，以靜態匯入讀取——缺檔即整個測試檔載入失敗（紅燈）。
 *
 * README／指南的比對規則（只比對明確的**現況宣稱**，不碰歷史敘述）：
 * 1. 只抓兩種寫法：
 *    - `` `info.version` X.Y.Z ``：反引號包住欄位名，其後緊接版本號；中間可有「為」「已升」或冒號，
 *      版本號可包在 `**粗體**` 或反引號內（例：`` `info.version` 已升 **1.2.0** ``）。
 *    - `` `info.version: X.Y.Z` ``：整段在同一組反引號內。
 *    「`asyncapi.yaml` 升 1.1.0」「`info.version` 當時維持 1.1.0」這類歷史敘述不符合上述緊鄰形式，天然不會被抓。
 * 2. 明確標記「（歷史）」或含「撰寫時」的行整行略過——保留在由來段／歷史快照中引用舊版號的空間。
 *    （不以「歷史」二字判斷：README 內文常有「歷史寫入」「歷史層」等與版本無關的用語。）
 * 3. README 至少要抓到 2 處、指南至少 2 處（§7 現況註記與 §15.6 契約版本），避免改寫法後規則靜默失效而假綠。
 */

const VERSION = String.raw`(\d+\.\d+\.\d+)`;
const CLAIM_RE = new RegExp(
  String.raw`\`info\.version\`\s*(?:為|已升|:|：)?\s*(?:\*\*|\`)?${VERSION}|\`info\.version:\s*${VERSION}\``,
  "g",
);
const HISTORICAL_LINE_RE = /（歷史）|撰寫時/;

interface Claim {
  line: number;
  version: string;
  text: string;
}

function extractClaims(markdown: string): Claim[] {
  const claims: Claim[] = [];
  markdown.split(/\r?\n/).forEach((text, index) => {
    if (HISTORICAL_LINE_RE.test(text)) return;
    for (const match of text.matchAll(CLAIM_RE)) {
      const version = match[1] ?? match[2];
      if (version !== undefined) claims.push({ line: index + 1, version, text: text.trim().slice(0, 120) });
    }
  });
  return claims;
}

const asyncapiVersion = (() => {
  const doc = parse(asyncapiRaw) as { info?: { version?: unknown } };
  const v = doc.info?.version;
  if (typeof v !== "string") throw new Error("asyncapi.yaml 缺少字串形態的 info.version");
  return v;
})();

function describeMismatches(file: string, claims: Claim[]): string[] {
  return claims
    .filter((c) => c.version !== asyncapiVersion)
    .map((c) => `${file}:${c.line} 宣稱 ${c.version}（asyncapi.yaml 為 ${asyncapiVersion}）：${c.text}`);
}

describe("文件的契約版本宣稱與 asyncapi.yaml 一致", () => {
  it("asyncapi.yaml 的 info.version 為 X.Y.Z", () => {
    expect(asyncapiVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("README.md 的 `info.version` 現況宣稱全部等於 asyncapi 版本", () => {
    const claims = extractClaims(readmeRaw);
    expect(claims.length, "README 應至少有 2 處 `info.version` 現況宣稱（規則失效？）").toBeGreaterThanOrEqual(2);
    expect(describeMismatches("README.md", claims)).toEqual([]);
  });

  it("實作指南的 `info.version` 現況宣稱全部等於 asyncapi 版本", () => {
    const claims = extractClaims(guideRaw);
    expect(
      claims.length,
      "指南應至少有 2 處 `info.version` 現況宣稱（§7 現況註記、§15.6 契約版本；規則失效？）",
    ).toBeGreaterThanOrEqual(2);
    expect(describeMismatches("docs/Flow-Gatekeeper-SDD-完整實作指南.md", claims)).toEqual([]);
  });
});

/**
 * CHANGELOG.md 的「契約」小節：取所有標題含「契約」的小節（到下一個同級或更高級標題為止）。
 * - 優先取小節內各子標題的**第一個** X.Y.Z（例：`### 1.2.0（產品 v1.1.0 起）` → 1.2.0；
 *   括號內的產品版本排在後面，不會被取到）。
 * - 若小節沒有帶版本號的子標題，退而收集「提到 asyncapi／info.version 的行」上的 X.Y.Z。
 * 只看這些位置，是為了不把小節內提到的相依版本（如 Zod 4.x）誤當契約版本。最高者須等於 asyncapi 版本。
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function contractVersionsInChangelog(markdown: string): string[] {
  const fromHeadings: string[] = [];
  const fromLines: string[] = [];
  let sectionLevel: number | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 0;
      const title = heading[2] ?? "";
      if (sectionLevel !== null && level <= sectionLevel) sectionLevel = null;
      if (sectionLevel === null) {
        if (title.includes("契約")) sectionLevel = level;
        continue;
      }
      const first = /\d+\.\d+\.\d+/.exec(title);
      if (first) fromHeadings.push(first[0]);
      continue;
    }
    if (sectionLevel === null) continue;
    if (!/asyncapi|info\.version/i.test(line)) continue;
    for (const m of line.matchAll(/\d+\.\d+\.\d+/g)) fromLines.push(m[0]);
  }
  return fromHeadings.length > 0 ? fromHeadings : fromLines;
}

describe("CHANGELOG.md 的契約版本與 asyncapi.yaml 一致", () => {
  it("「契約」小節中的最高版本號等於 asyncapi 版本", () => {
    const versions = contractVersionsInChangelog(changelogRaw);
    expect(
      versions.length,
      "CHANGELOG.md 找不到含版本號的「契約」小節（標題需含「契約」，版本寫在其子標題或提到 asyncapi／info.version 的行）",
    ).toBeGreaterThan(0);
    const highest = [...versions].sort(compareSemver).at(-1);
    expect(highest, `CHANGELOG「契約」小節收集到的版本：${versions.join("、")}`).toBe(asyncapiVersion);
  });
});
