import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useMonitoringStore } from "../../monitoring/stores/monitoring.store.js";
import { useCopilotStore } from "../stores/copilot.store.js";
import { UNAUTHORIZED_DIAGNOSE_MESSAGE } from "../lib/diagnose-api.js";
import { CONNECTION_NOT_READY_MESSAGE, useDiagnoseTrigger } from "./useDiagnoseTrigger.js";

describe("useDiagnoseTrigger — 可否診斷看「連線活著且已授權」（WEB-3／AR-S7）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setup(): {
    monitoring: ReturnType<typeof useMonitoringStore>;
    trigger: ReturnType<typeof useDiagnoseTrigger>;
  } {
    const monitoring = useMonitoringStore();
    const trigger = useDiagnoseTrigger();
    monitoring.selectMachine("mixer-01");
    return { monitoring, trigger };
  }

  function goLive(monitoring: ReturnType<typeof useMonitoringStore>, clientId: string): void {
    monitoring.setConnectionStatus("connected");
    monitoring.setClientId(clientId);
    monitoring.setAuthorized(true);
  }

  it("connected＋clientId＋machine/subscribed 且有選台 → 可診斷、無停用原因", () => {
    const { monitoring, trigger } = setup();
    goLive(monitoring, "c1");
    expect(trigger.hasClient.value).toBe(true);
    expect(trigger.canDiagnoseSelected.value).toBe(true);
    expect(trigger.connectionBlockedReason.value).toBeNull();
  });

  it("system/connected 之後、machine/subscribed 之前 → 不可診斷（避免 1 RTT 空窗必得 409）", () => {
    const { monitoring, trigger } = setup();
    monitoring.setConnectionStatus("connected");
    monitoring.setClientId("c1");
    expect(trigger.canDiagnoseSelected.value).toBe(false);
    expect(trigger.connectionBlockedReason.value).toBe(CONNECTION_NOT_READY_MESSAGE);
  });

  it("system/unauthorized 後 → 不可診斷，停用原因為未授權", () => {
    const { monitoring, trigger } = setup();
    goLive(monitoring, "c1");
    monitoring.setAuthorized(false);
    expect(trigger.canDiagnoseSelected.value).toBe(false);
    expect(trigger.connectionBlockedReason.value).toBe(UNAUTHORIZED_DIAGNOSE_MESSAGE);
  });

  it("斷線（reconnecting）後即使曾拿到過 clientId 也不可診斷；重連並完成訂閱後恢復", () => {
    const { monitoring, trigger } = setup();
    goLive(monitoring, "c1");
    monitoring.setConnectionStatus("reconnecting");
    expect(trigger.hasClient.value).toBe(false);
    expect(trigger.canDiagnoseSelected.value).toBe(false);

    monitoring.setConnectionStatus("connected"); // 新 socket open，尚未派發 clientId
    expect(trigger.canDiagnoseSelected.value).toBe(false);
    monitoring.setClientId("c2");
    expect(trigger.canDiagnoseSelected.value).toBe(false); // 尚未重新訂閱
    monitoring.setAuthorized(true);
    expect(trigger.canDiagnoseSelected.value).toBe(true);
  });

  // 對現行實作（hasClient 由 connectionBlockedReason 推導）此測試恆真；它的價值是回歸防線——
  // 日後若有人又把兩者改回各寫一份條件，只要任一狀態下兩者分歧就會在此失敗。
  it("hasClient 與 connectionBlockedReason 在各連線狀態下永遠一致（前者＝後者為 null）", () => {
    const { monitoring, trigger } = setup();
    const agree = (): void =>
      expect(trigger.hasClient.value).toBe(trigger.connectionBlockedReason.value === null);
    agree(); // 初始：未連線
    monitoring.setConnectionStatus("connected");
    agree();
    monitoring.setClientId("c1");
    agree(); // 尚未訂閱
    monitoring.setAuthorized(true);
    agree(); // live
    expect(trigger.hasClient.value).toBe(true);
    monitoring.setAuthorized(false);
    agree(); // 未授權
    monitoring.setConnectionStatus("reconnecting");
    agree();
    expect(trigger.hasClient.value).toBe(false);
  });

  it("斷線期間 diagnose 不送出 POST（socketId 已清空）", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { monitoring, trigger } = setup();
    goLive(monitoring, "c1");
    monitoring.setConnectionStatus("reconnecting");
    trigger.diagnose("mixer-01");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useCopilotStore().stateFor("mixer-01").status).toBe("idle");
  });

  it("system/connected 後、machine/subscribed 前按卡片 icon（diagnose）→ 不送 POST，但仍選台", () => {
    const fetchSpy = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchSpy);
    const { monitoring, trigger } = setup();
    monitoring.setConnectionStatus("connected");
    monitoring.setClientId("c1");
    trigger.diagnose("mixer-02");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(monitoring.selectedMachineId).toBe("mixer-02");
    expect(useCopilotStore().stateFor("mixer-02").status).toBe("idle");
  });

  it("system/unauthorized 期間 diagnose／retry 都不送 POST（clientId 仍在也一樣）", () => {
    const fetchSpy = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchSpy);
    const { monitoring, trigger } = setup();
    goLive(monitoring, "c1");
    monitoring.setAuthorized(false);
    expect(monitoring.clientId).toBe("c1");
    trigger.diagnose("mixer-01");
    trigger.retry("mixer-01");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POST 往返中收到 system/unauthorized、後端回 409 → 顯示未授權句而非「等待重連」", async () => {
    let resolveFetch: (res: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const { monitoring, trigger } = setup();
    goLive(monitoring, "c1");
    trigger.diagnose("mixer-01");
    monitoring.setAuthorized(false);
    resolveFetch(new Response("", { status: 409 }));
    await vi.waitFor(() => {
      expect(useCopilotStore().stateFor("mixer-01")).toMatchObject({
        status: "failed",
        error: UNAUTHORIZED_DIAGNOSE_MESSAGE,
      });
    });
  });
});
