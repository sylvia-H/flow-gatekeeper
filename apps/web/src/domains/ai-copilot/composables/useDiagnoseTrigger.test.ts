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
