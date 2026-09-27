import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import asyncapiRaw from "../../../asyncapi.yaml?raw";
import { DiagnosisResultSchema } from "./schemas.js";
import { WS_MESSAGE_TYPES } from "./events.js";
import { MachineSubscribeSchema, PingSchema } from "./ws-client.js";
import { AiDoneSchema, AiErrorSchema, AiTokenSchema } from "./ai-stream.js";
import { JobStatusSchema } from "./job-status.js";
import { WorkerMetricsSchema } from "./metrics.js";

/**
 * Zod（單一來源）與 asyncapi.yaml（對外文件）之間的漂移偵測。
 * Spectral 只檢查 YAML 本身合規，不會發現兩邊不一致；這裡補上語意比對，
 * 讓改了契約卻忘了改文件（或反過來）在 test 就紅。
 */

type Json = Record<string, unknown>;

const doc = parse(asyncapiRaw) as Json;
const components = doc.components as { messages: Record<string, Json>; schemas: Record<string, Json> };

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 解析 asyncapi 內部 `$ref`（僅支援 `#/...` 本檔參照）。 */
function resolveRef(node: unknown): unknown {
  if (!isObject(node) || typeof node.$ref !== "string") return node;
  const path = node.$ref.replace(/^#\//, "").split("/");
  let cur: unknown = doc;
  for (const key of path) cur = isObject(cur) ? cur[key] : undefined;
  if (cur === undefined) throw new Error(`無法解析 $ref：${node.$ref}`);
  return resolveRef(cur);
}

/** 會影響「哪些值合法」的數值／長度／樣式限制，兩邊必須一致。 */
const CONSTRAINT_KEYS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
] as const;

/**
 * 正規化成只保留「語意」的形狀：型別、enum／const、限制條件、屬性、required、陣列元素、
 * anyOf／oneOf 分支。`$schema`、`additionalProperties`、`description`、`format` 等不影響
 * 資料形狀的差異一律略過；有 enum 或 const 時略過 `type`（zod 會輸出 `type: string`，
 * asyncapi 只寫 enum／const，兩者等價）。
 */
function normalize(node: unknown): unknown {
  const n = resolveRef(node);
  if (!isObject(n)) return n;
  const out: Json = {};
  for (const key of CONSTRAINT_KEYS) {
    if (n[key] === undefined) continue;
    // Zod 4 的 int 隱含 JS 安全整數範圍、toJSONSchema 會輸出成上下限；那是表示極限不是契約限制
    if (key === "minimum" && n[key] === -Number.MAX_SAFE_INTEGER) continue;
    if (key === "maximum" && n[key] === Number.MAX_SAFE_INTEGER) continue;
    out[key] = n[key];
  }
  // anyOf 與 oneOf 在此的用法（nullable 聯集）語意相同，統一成排序後的 anyOf 比對
  const branches = [n.anyOf, n.oneOf].find(Array.isArray) as unknown[] | undefined;
  if (branches) {
    out.anyOf = branches.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (Array.isArray(n.enum)) {
    out.enum = [...(n.enum as unknown[])].map(String).sort();
  } else if ("const" in n) {
    out.const = n.const;
  } else if (n.type !== undefined) {
    out.type = Array.isArray(n.type) ? [...(n.type as unknown[])].map(String).sort() : n.type;
  }
  if (isObject(n.properties)) {
    const props: Json = {};
    for (const key of Object.keys(n.properties).sort()) {
      props[key] = normalize(n.properties[key]);
    }
    out.properties = props;
    out.required = Array.isArray(n.required) ? [...(n.required as unknown[])].map(String).sort() : [];
    out.type = "object";
  }
  if (n.items !== undefined) out.items = normalize(n.items);
  return out;
}

/** 取某則 message 的訊息 `type` 字面值；payload 為陣列時（如 machine/data）取元素的 `type`。 */
function messageTypeConst(message: Json): unknown {
  let payload = resolveRef(message.payload);
  if (isObject(payload) && payload.type === "array") payload = resolveRef(payload.items);
  if (!isObject(payload) || !isObject(payload.properties)) return undefined;
  const typeProp = resolveRef(payload.properties.type);
  return isObject(typeProp) ? typeProp.const : undefined;
}

describe("asyncapi.yaml 與 Zod 契約同步", () => {
  it("components.schemas.DiagnosisResult 與 DiagnosisResultSchema 語意等價", () => {
    const fromZod = z.toJSONSchema(DiagnosisResultSchema, { target: "draft-7", io: "input" });
    expect(normalize(components.schemas.DiagnosisResult)).toEqual(normalize(fromZod));
  });

  it.each<[string, () => unknown, z.ZodType]>([
    ["messages.Ping", () => components.messages.Ping?.payload, PingSchema],
    ["messages.MachineSubscribe", () => components.messages.MachineSubscribe?.payload, MachineSubscribeSchema],
    ["messages.JobStatus", () => components.messages.JobStatus?.payload, JobStatusSchema],
    ["messages.AiToken", () => components.messages.AiToken?.payload, AiTokenSchema],
    ["messages.AiDone", () => components.messages.AiDone?.payload, AiDoneSchema],
    ["messages.AiError", () => components.messages.AiError?.payload, AiErrorSchema],
    ["schemas.WorkerMetrics", () => components.schemas.WorkerMetrics, WorkerMetricsSchema],
  ])("%s 與對應 Zod schema 語意等價", (_name, pick, schema) => {
    const documented = pick();
    expect(documented).toBeDefined();
    const fromZod = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
    expect(normalize(documented)).toEqual(normalize(fromZod));
  });

  it("WS_MESSAGE_TYPES 與 asyncapi 各 message 的 type const 集合相等", () => {
    const documented = Object.values(components.messages).map(messageTypeConst);
    expect(documented.every((t) => typeof t === "string")).toBe(true);
    expect(new Set(documented)).toEqual(new Set(WS_MESSAGE_TYPES));
    // 集合相等之外也確認沒有重複定義同一 type 的 message
    expect(documented).toHaveLength(WS_MESSAGE_TYPES.length);
  });

  it("machine/data 的 payload 為 TelemetryPoint 陣列（無 envelope）", () => {
    const payload = resolveRef(components.messages.MachineData?.payload);
    expect(isObject(payload) && payload.type).toBe("array");
    expect(isObject(payload) && payload.items).toEqual({ $ref: "#/components/schemas/TelemetryPoint" });
  });

  it("ai/token、ai/done、ai/error 皆將 attempt 列為必填整數", () => {
    for (const name of ["AiToken", "AiDone", "AiError"]) {
      const payload = resolveRef(components.messages[name]?.payload) as Json;
      expect(payload.required, name).toContain("attempt");
      expect((payload.properties as Json).attempt, name).toMatchObject({ type: "integer", minimum: 1 });
    }
  });
});
