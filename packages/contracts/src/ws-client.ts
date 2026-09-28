import { z } from "zod";

/**
 * 客戶端→伺服器的 WS 控制訊息（不可信輸入）。
 *
 * 這條方向的 payload 來自任意連線者，Gateway 必須先 `safeParse` 才能分派——
 * 憲章 III「需 runtime 驗證的 payload MUST 用 Zod」正適用於此，不屬於「純型別分派 MAY 用 TS」
 * 的豁免。型別一律由 `z.infer` 推導，不另寫平行定義。
 */

/** ping：客戶端應用層心跳請求。 */
export const PingSchema = z.object({ type: z.literal("ping") });

/**
 * machine/subscribe：客戶端訂閱機台遙測。
 * 長度與數量上限是為了封住 DoS 面：未設上限時單則訊息即可塞入任意大的 token／機台清單，
 * Gateway 還會對每個 id 建 Set 並在每次廣播時比對。
 */
export const MachineSubscribeSchema = z.object({
  type: z.literal("machine/subscribe"),
  token: z.string().max(512),
  machineIds: z.array(z.string().min(1).max(64)).max(50),
});

/** 客戶端→伺服器的控制訊息聯集（Gateway 以 `safeParse` 驗證後依 `type` narrow）。 */
export const ClientControlMessageSchema = z.discriminatedUnion("type", [
  PingSchema,
  MachineSubscribeSchema,
]);

export type Ping = z.infer<typeof PingSchema>;
export type MachineSubscribe = z.infer<typeof MachineSubscribeSchema>;
export type ClientControlMessage = z.infer<typeof ClientControlMessageSchema>;
