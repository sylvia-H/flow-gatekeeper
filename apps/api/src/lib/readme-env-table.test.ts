import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApiEnvSchema } from "./env-schema.js";

/**
 * README「環境變數」表必須涵蓋 api env-schema 的全部 key（審查報告 review02 §6 Batch C 第 8 項、§3.7 DOC-7）。
 *
 * 解析規則：從 README 的 `## 環境變數` 標題之後的第一張 Markdown 表取資料列；
 * 第一欄的每個 `` `KEY` ``（一格可列多個，如 `` `REDIS_HOST` / `REDIS_PORT` ``）都算一個變數，
 * 第二欄「所在 app」去掉粗體後以「·」切分，含 `api` 這個 token 即視為 api 變數。
 *
 * 斷言：
 * (a) schema 的每個 key 都出現在表中且 scope 含 api；
 * (b) 反向：表中標為 api、卻不在 schema 也不在下方例外清單的 key 一律 fail，避免文件殘留幽靈變數；
 * (c) 例外清單本身不得過期：「表上有、schema 沒有」的 key 必須仍在表中標為 api，「schema 有、表可不列」的 key 必須仍在 schema。
 *
 * 表格解析函式與 worker 的同名測試刻意重複：兩個 app 不共用測試 helper，避免為測試引入跨 app 相依。
 */

/**
 * 表中標為 api、但刻意不由 `ApiEnvSchema` 解析的變數。這些走「不合法回退預設並 warn」語意，
 * 不升級為 fail-fast（見 env-schema.ts 檔頭註解與 README「數值變數的驗證」段）。
 */
const README_ONLY_API_KEYS: Readonly<Record<string, string>> = {
  LOG_LEVEL: "由 @flow-gatekeeper/shared/logging 解析（回退 info + warn）",
  LOG_PRETTY: "由 @flow-gatekeeper/shared/logging 解析（依 NODE_ENV 推導）",
  METRICS_INTERVAL_MS: "由 shared/logging 與 metrics.service 解析（回退 60000 + warn）",
  METRICS_LOG_LEVEL: "由 @flow-gatekeeper/shared/logging 解析",
  HEALTH_PROBE_TIMEOUT_MS: "由 lib/health-probe-timeout.ts 解析（回退 2000 + warn）",
};

/** schema 有、但 README 表可以不列的 key（目前無）。 */
const SCHEMA_ONLY_API_KEYS: Readonly<Record<string, string>> = {};

const SCOPE = "api";

const readmePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../README.md");

/** 回傳 key → 該列 scope token 集合（同一 key 出現多列時合併）。 */
function parseReadmeEnvTable(markdown: string): Map<string, Set<string>> {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+環境變數\s*$/.test(l));
  if (start < 0) throw new Error("README.md 找不到「## 環境變數」標題");
  const table = new Map<string, Set<string>>();
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    if (!line.startsWith("|")) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const [keyCell = "", scopeCell = ""] = cells;
    if (/^-+$/.test(keyCell.replace(/[:\s]/g, ""))) continue; // 分隔列
    const keys = [...keyCell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1] ?? "");
    if (keys.length === 0) continue; // 表頭
    const scopes = scopeCell
      .replace(/\*\*/g, "")
      .split("·")
      .map((s) => s.trim());
    for (const key of keys) {
      const set = table.get(key) ?? new Set<string>();
      for (const s of scopes) set.add(s);
      table.set(key, set);
    }
  }
  if (table.size === 0) throw new Error("README.md「環境變數」表解析結果為空（表格式變了？）");
  return table;
}

const table = parseReadmeEnvTable(readFileSync(readmePath, "utf8"));
const schemaKeys = Object.keys(ApiEnvSchema.shape).sort();

describe("README 環境變數表 ↔ api env-schema", () => {
  it("(a) env-schema 的每個 key 都列在 README 表中，且所在 app 含 api", () => {
    const missing = schemaKeys.filter((k) => !(k in SCHEMA_ONLY_API_KEYS) && !table.has(k));
    const wrongScope = schemaKeys.filter((k) => table.has(k) && !table.get(k)?.has(SCOPE));
    expect(missing, `README「環境變數」表缺少以下 api 變數：${missing.join("、")}`).toEqual([]);
    expect(wrongScope, `README 表中以下變數的「所在 app」未標 api：${wrongScope.join("、")}`).toEqual([]);
  });

  it("(b) README 表中標為 api 的 key 都在 env-schema 或已知例外清單內（無幽靈變數）", () => {
    const extra = [...table]
      .filter(([k, scopes]) => scopes.has(SCOPE) && !schemaKeys.includes(k) && !(k in README_ONLY_API_KEYS))
      .map(([k]) => k)
      .sort();
    expect(extra, `README 表標為 api、但 env-schema 與例外清單都沒有：${extra.join("、")}`).toEqual([]);
  });

  it("(c) 例外清單未過期", () => {
    const staleReadmeOnly = Object.keys(README_ONLY_API_KEYS).filter((k) => !table.get(k)?.has(SCOPE));
    const staleSchemaOnly = Object.keys(SCHEMA_ONLY_API_KEYS).filter((k) => !schemaKeys.includes(k));
    expect(
      staleReadmeOnly,
      `README_ONLY_API_KEYS 已過期（README 表已無此 key 或未標 api），請從清單移除：${staleReadmeOnly.join("、")}`,
    ).toEqual([]);
    expect(
      staleSchemaOnly,
      `SCHEMA_ONLY_API_KEYS 已過期（env-schema 已無此 key），請從清單移除：${staleSchemaOnly.join("、")}`,
    ).toEqual([]);
  });
});
