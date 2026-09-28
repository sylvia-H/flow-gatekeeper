import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import asyncapiRaw from "../../../asyncapi.yaml?raw";
import { DiagnosisResultSchema } from "./schemas.js";
import {
  MachineSubscribedSchema,
  PongSchema,
  SystemConnectedSchema,
  SystemMetricsSchema,
  SystemUnauthorizedSchema,
  TelemetryPointSchema,
  WS_MESSAGE_TYPES,
} from "./events.js";
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

/** 會影響「哪些值合法」的數值／長度／樣式／格式限制，兩邊必須一致。 */
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
  "format",
] as const;

/**
 * Zod 4 的 `z.number().int()` 即 `z.int()`，隱含 JS 安全整數範圍，`toJSONSchema` 會把它輸出成
 * `minimum: -2^53+1`／`maximum: 2^53-1`。這是 JS number 的表示極限、不是契約限制，
 * asyncapi 不必逐欄寫出，比對時略過（只略過恰好等於安全整數邊界的值，其餘上下限照比）。
 */
const SAFE_INT_BOUND = Number.MAX_SAFE_INTEGER;

/**
 * 各 `format` 在 Zod 輸出中附帶的內建 regex（format 的實作細節）。以 `z.toJSONSchema` 實際產生
 * 取得基準，不手抄 regex：Zod 升版改了內建 regex 時基準跟著變，不會誤判成漂移。
 * `date-time` 收兩種變體（預設只收 `Z`、`offset: true` 另收 `±hh:mm`）。
 */
function builtinPattern(schema: z.ZodType): string {
  const out = z.toJSONSchema(schema, { target: "draft-7" }) as Json;
  if (typeof out.pattern !== "string") throw new Error("預期 Zod 對此 format 輸出 pattern");
  return out.pattern;
}
const FORMAT_BUILTIN_PATTERNS: Record<string, ReadonlySet<string>> = {
  "date-time": new Set([builtinPattern(z.iso.datetime()), builtinPattern(z.iso.datetime({ offset: true }))]),
  uuid: new Set([builtinPattern(z.uuid())]),
};

/** `pattern` 恰為該節點 `format` 的 Zod 內建 regex 時才可略過；自訂 pattern 一律保留比對。 */
function isBuiltinFormatPattern(n: Json): boolean {
  if (typeof n.format !== "string" || typeof n.pattern !== "string") return false;
  return FORMAT_BUILTIN_PATTERNS[n.format]?.has(n.pattern) ?? false;
}

/**
 * Zod → JSON Schema。target 選 draft-7：AsyncAPI 2.6 的 Schema Object 是 JSON Schema draft-07
 * 的超集。`io: "input"` 描述「線上可被接受的輸入」：z.object 預設 strip（多餘鍵接受後丟棄），
 * input 模式不輸出 `additionalProperties`，與 asyncapi 未宣告（＝允許額外鍵）等價；
 * output 模式會輸出 `additionalProperties: false`，描述的是 parse 後的形狀、不是線上契約。
 */
function fromZod(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { target: "draft-7", io: "input" });
}

/**
 * 正規化成只保留「語意」的形狀：型別、enum／const、限制條件（含 `format`、`pattern`）、屬性、
 * required、`additionalProperties`、陣列元素、anyOf／oneOf／allOf 分支。略過的只有不影響資料合法性的鍵
 * （`$schema`、`description` 等）與兩項 Zod 輸出特性：
 * - `pattern` 恰為同節點 `format` 的 Zod 內建 regex 時略過（見 `FORMAT_BUILTIN_PATTERNS`）：那是
 *   format 的實作細節，asyncapi 只寫 format 即表達同一限制。自訂 pattern（任一端多寫）照常比對。
 * - 安全整數邊界（見 `SAFE_INT_BOUND`）。
 * 有 enum 或 const 時略過 `type`（zod 會輸出 `type: string`，asyncapi 只寫 enum／const，兩者等價）。
 */
function normalize(node: unknown): unknown {
  const n = resolveRef(node);
  if (!isObject(n)) return n;
  const out: Json = {};
  for (const key of CONSTRAINT_KEYS) {
    if (n[key] === undefined) continue;
    if (key === "pattern" && isBuiltinFormatPattern(n)) continue;
    if (key === "minimum" && n[key] === -SAFE_INT_BOUND) continue;
    if (key === "maximum" && n[key] === SAFE_INT_BOUND) continue;
    out[key] = n[key];
  }
  // anyOf 與 oneOf 在此的用法（nullable 聯集）語意相同，統一成排序後的 anyOf 比對
  const branches = [n.anyOf, n.oneOf].find(Array.isArray) as unknown[] | undefined;
  if (branches) {
    out.anyOf = branches.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  // allOf：Zod 對同一字串疊多個 regex 時會輸出 allOf（且丟掉 format），不比對就會讓多出的限制漏網
  if (Array.isArray(n.allOf)) {
    out.allOf = (n.allOf as unknown[])
      .map(normalize)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
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
  if (n.additionalProperties !== undefined) out.additionalProperties = normalize(n.additionalProperties);
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

/**
 * asyncapi 每一則 message 的 payload 對應的 Zod schema。machine/data 傳輸時為無 envelope 的陣列，
 * 以 `z.array(TelemetryPointSchema)` 表達。新增 message 而漏列在此，下方覆蓋率測試會紅。
 */
const MESSAGE_SCHEMAS: Record<string, z.ZodType> = {
  MachineSubscribe: MachineSubscribeSchema,
  MachineData: z.array(TelemetryPointSchema),
  JobStatus: JobStatusSchema,
  AiToken: AiTokenSchema,
  AiDone: AiDoneSchema,
  AiError: AiErrorSchema,
  Ping: PingSchema,
  SystemConnected: SystemConnectedSchema,
  MachineSubscribed: MachineSubscribedSchema,
  Pong: PongSchema,
  SystemUnauthorized: SystemUnauthorizedSchema,
  SystemMetrics: SystemMetricsSchema,
};

describe("asyncapi.yaml 與 Zod 契約同步", () => {
  it.each<[string, z.ZodType]>([
    ["DiagnosisResult", DiagnosisResultSchema],
    ["WorkerMetrics", WorkerMetricsSchema],
    ["TelemetryPoint", TelemetryPointSchema],
  ])("components.schemas.%s 與對應 Zod schema 語意等價", (name, schema) => {
    const documented = components.schemas[name];
    expect(documented).toBeDefined();
    expect(normalize(documented)).toEqual(normalize(fromZod(schema)));
  });

  it.each(Object.entries(MESSAGE_SCHEMAS))("messages.%s 的 payload 與對應 Zod schema 語意等價", (name, schema) => {
    const documented = components.messages[name]?.payload;
    expect(documented).toBeDefined();
    expect(normalize(documented)).toEqual(normalize(fromZod(schema)));
  });

  it("asyncapi 的每一則 message 都有結構比對（不只驗 type const）", () => {
    expect(new Set(Object.keys(MESSAGE_SCHEMAS))).toEqual(new Set(Object.keys(components.messages)));
  });

  it("normalize 不再略過 format：uuid 與無 format 的字串視為不等價", () => {
    expect(normalize(fromZod(z.object({ id: z.uuid() })))).not.toEqual(
      normalize({ type: "object", required: ["id"], properties: { id: { type: "string" } } }),
    );
    expect(normalize(fromZod(z.object({ id: z.uuid() })))).toEqual(
      normalize({ type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } }),
    );
  });

  it("normalize 只略過 format 的內建 pattern：自訂 pattern 或他種 format 的 regex 仍比對", () => {
    const dt = FORMAT_BUILTIN_PATTERNS["date-time"];
    expect(dt?.size).toBe(2);
    for (const pattern of dt ?? []) {
      expect(normalize({ type: "string", format: "date-time", pattern })).toEqual(
        normalize({ type: "string", format: "date-time" }),
      );
    }
    // 自訂 pattern 與 format 並存 → 不略過
    expect(normalize({ type: "string", format: "date-time", pattern: "^2026" })).not.toEqual(
      normalize({ type: "string", format: "date-time" }),
    );
    // 別種 format 的內建 regex 掛在 date-time 上 → 不略過
    const [uuidPattern] = [...(FORMAT_BUILTIN_PATTERNS.uuid ?? [])];
    expect(normalize({ type: "string", format: "date-time", pattern: uuidPattern })).not.toEqual(
      normalize({ type: "string", format: "date-time" }),
    );
  });

  it("mutation：asyncapi 端多一個自訂 pattern 時比對會失敗", () => {
    const zodSide = normalize(fromZod(SystemMetricsSchema));
    const documented = structuredClone(resolveRef(components.messages.SystemMetrics?.payload)) as Json;
    expect(normalize(documented)).toEqual(zodSide);
    const props = documented.properties as Record<string, Json>;
    props.collectedAt = { ...props.collectedAt, pattern: "^2026-" };
    expect(normalize(documented)).not.toEqual(zodSide);
  });

  it("mutation：Zod 端多一個自訂 regex 時比對會失敗", () => {
    const documented = normalize(components.messages.SystemMetrics?.payload);
    expect(normalize(fromZod(SystemMetricsSchema))).toEqual(documented);
    // format 保留、只換成自訂 pattern（模擬 Zod 輸出單一自訂 pattern 的情形）
    const zodJson = structuredClone(fromZod(SystemMetricsSchema)) as Json;
    const props = zodJson.properties as Record<string, Json>;
    props.collectedAt = { ...props.collectedAt, pattern: "^2026-" };
    expect(normalize(zodJson)).not.toEqual(documented);
    // 真的在 Zod 端疊 regex（輸出 allOf）
    const mutated = SystemMetricsSchema.extend({
      collectedAt: z.iso.datetime({ offset: true }).regex(/^2026-/),
    });
    expect(normalize(fromZod(mutated))).not.toEqual(documented);
  });

  it("normalize 會比對 additionalProperties：strict 物件與未宣告者不等價", () => {
    const open = { type: "object", required: ["a"], properties: { a: { type: "string" } } };
    expect(normalize(fromZod(z.object({ a: z.string() })))).toEqual(normalize(open));
    expect(normalize(fromZod(z.strictObject({ a: z.string() })))).not.toEqual(normalize(open));
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
