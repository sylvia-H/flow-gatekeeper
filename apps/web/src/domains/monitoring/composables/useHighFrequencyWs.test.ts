import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { effectScope, type EffectScope } from "vue";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import {
  useHighFrequencyWs,
  type HighFrequencyWsHandle,
  type UseHighFrequencyWsOptions,
} from "./useHighFrequencyWs.js";

/** 一幀的長度：fake timers 的 rAF 以 16ms 為界觸發。 */
const FRAME = 16;

/** 最小可控的 WebSocket 替身：測試端手動 open／收訊息／關閉。 */
class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  // ── 測試端操作 ──
  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  serverSend(payload: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("尚未建立任何 WebSocket");
    return ws;
  }
}

function pt(machineId: string, state: MachineState = "healthy", temperature = 60): TelemetryPoint {
  return {
    type: "machine/data",
    machineId,
    timestamp: "2026-09-27T00:00:00.000Z",
    telemetry: { temperature, vibration: 1, throughput: 100, errorRate: 0 },
    state,
  };
}

type Spies = {
  onBatch: Mock<UseHighFrequencyWsOptions["onBatch"]>;
  onStatus: Mock<UseHighFrequencyWsOptions["onStatus"]>;
  onConnected: Mock<UseHighFrequencyWsOptions["onConnected"]>;
  onDrop: Mock<NonNullable<UseHighFrequencyWsOptions["onDrop"]>>;
};

let scope: EffectScope;
let windowTarget: EventTarget;

/** 在 effectScope 內建立 composable；scope.stop() 即模擬元件卸載。 */
function mount(overrides: Partial<UseHighFrequencyWsOptions> = {}): {
  handle: HighFrequencyWsHandle;
  spies: Spies;
} {
  const spies: Spies = {
    onBatch: vi.fn(),
    onStatus: vi.fn(),
    onConnected: vi.fn(),
    onDrop: vi.fn(),
  };
  scope = effectScope();
  const handle = scope.run(() =>
    useHighFrequencyWs({
      url: "ws://test/ws",
      onBatch: spies.onBatch,
      onStatus: spies.onStatus,
      onConnected: spies.onConnected,
      onDrop: spies.onDrop,
      ...overrides,
    }),
  );
  if (!handle) throw new Error("effectScope 未回傳 handle");
  return { handle, spies };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  // node 環境沒有 rAF／window／document：先放佔位，fake timers 才會接管 rAF。
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), FRAME));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  windowTarget = new EventTarget();
  vi.stubGlobal("window", windowTarget);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  vi.spyOn(Math, "random").mockReturnValue(0); // 退避抖動歸零，延遲可預期
});

afterEach(() => {
  scope?.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useHighFrequencyWs — rAF 批次（憲章 IV／硬規則 1）", () => {
  it("同一幀內的多則訊息只提交一次批次；無資料的幀不提交", () => {
    const { spies } = mount();
    const ws = FakeWebSocket.latest();
    ws.serverOpen();
    ws.serverSend([pt("a"), pt("b")]);
    ws.serverSend([pt("a"), pt("b")]);
    ws.serverSend([pt("c")]);
    expect(spies.onBatch).not.toHaveBeenCalled(); // onmessage 不直接寫 store

    vi.advanceTimersByTime(FRAME);
    expect(spies.onBatch).toHaveBeenCalledTimes(1);
    expect(spies.onBatch.mock.calls[0]?.[0]).toHaveLength(5);

    vi.advanceTimersByTime(FRAME * 3);
    expect(spies.onBatch).toHaveBeenCalledTimes(1);
  });

  it("畸形資料點在入口剔除並以 onDrop('invalid') 回報，其餘照常入 buffer", () => {
    const { spies } = mount();
    const ws = FakeWebSocket.latest();
    ws.serverOpen();
    ws.serverSend([pt("a"), null, { type: "machine/data", machineId: "x" }]);
    expect(spies.onDrop).toHaveBeenCalledWith(2, "invalid");
    vi.advanceTimersByTime(FRAME);
    expect(spies.onBatch.mock.calls[0]?.[0].map((p) => p.machineId)).toEqual(["a"]);
  });

  it("onBatch 丟例外不讓下一幀停排；log 節流（首次立即印，之後每 10 秒最多一則）", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrower = vi.fn<UseHighFrequencyWsOptions["onBatch"]>(() => {
      throw new TypeError("boom");
    });
    mount({ onBatch: thrower });
    const ws = FakeWebSocket.latest();
    ws.serverOpen();
    for (let i = 0; i < 5; i += 1) {
      ws.serverSend([pt("a")]);
      vi.advanceTimersByTime(FRAME);
    }
    expect(thrower).toHaveBeenCalledTimes(5); // 每幀都還在 flush＝pump 沒停
    expect(thrower.mock.calls.every(([batch]) => batch.length === 1)).toBe(true); // 壞批次不回灌
    expect(errorSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    ws.serverSend([pt("a")]);
    vi.advanceTimersByTime(FRAME);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(String(errorSpy.mock.calls[1]?.[0])).toContain("累計 6 次");
  });
});

describe("useHighFrequencyWs — 溢位與暫停", () => {
  it("超過 maxBufferSize 時合併：每台保留最新＋轉換點，丟棄筆數以 onDrop('overflow') 回報", () => {
    let paused = true;
    const { spies } = mount({ maxBufferSize: 10, isPaused: () => paused });
    const ws = FakeWebSocket.latest();
    ws.serverOpen();
    // a：前 10 筆 healthy、第 11 筆轉 critical、之後 critical；b：只在最前面送過一筆
    ws.serverSend([pt("b", "healthy", 1)]);
    for (let i = 0; i < 20; i += 1) {
      ws.serverSend([pt("a", i < 10 ? "healthy" : "critical", 100 + i)]);
    }
    vi.advanceTimersByTime(FRAME * 5);
    expect(spies.onBatch).not.toHaveBeenCalled();

    paused = false;
    vi.advanceTimersByTime(FRAME);
    const batch = spies.onBatch.mock.calls[0]?.[0] ?? [];
    expect(batch.length).toBeLessThanOrEqual(10);
    // b 的唯一一筆、a 的轉換點（critical 首筆）與 a 的最新一筆都在
    expect(batch.some((p) => p.machineId === "b")).toBe(true);
    expect(batch.some((p) => p.machineId === "a" && p.telemetry.temperature === 110)).toBe(true);
    expect(batch.at(-1)?.telemetry.temperature).toBe(119);
    const dropped = spies.onDrop.mock.calls
      .filter(([, reason]) => reason === "overflow")
      .reduce((sum, [n]) => sum + n, 0);
    expect(dropped + batch.length).toBe(21); // 沒有任何一筆憑空消失而未計數
  });

  it("pause 期間續存不提交；resume 後下一幀一次沖出全部", () => {
    let paused = false;
    const { spies } = mount({ isPaused: () => paused });
    const ws = FakeWebSocket.latest();
    ws.serverOpen();
    paused = true;
    for (let i = 0; i < 4; i += 1) {
      ws.serverSend([pt("a"), pt("b")]);
      vi.advanceTimersByTime(FRAME);
    }
    expect(spies.onBatch).not.toHaveBeenCalled();

    paused = false;
    vi.advanceTimersByTime(FRAME);
    expect(spies.onBatch).toHaveBeenCalledTimes(1);
    expect(spies.onBatch.mock.calls[0]?.[0]).toHaveLength(8);
  });

  it("初始即 hidden（背景開新分頁）也會啟用 timer flush；回前景後停用", () => {
    const doc = document as unknown as EventTarget & { visibilityState: string };
    doc.visibilityState = "hidden";
    // 背景分頁的 rAF 實際上不會跑：換成永不觸發的佔位，只驗 timer flush
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { spies } = mount();
    const ws = FakeWebSocket.latest();
    ws.serverOpen();
    ws.serverSend([pt("a"), pt("b")]);
    vi.advanceTimersByTime(1_000);
    expect(spies.onBatch).toHaveBeenCalledTimes(1);

    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    ws.serverSend([pt("a")]);
    vi.advanceTimersByTime(2_000);
    expect(spies.onBatch).toHaveBeenCalledTimes(1); // timer 已停；此處 rAF 為佔位不 flush
  });

  it("背景分頁（rAF 停擺）改以 timer flush；回前景後停用", () => {
    const { spies } = mount();
    const ws = FakeWebSocket.latest();
    ws.serverOpen();
    const doc = document as unknown as EventTarget & { visibilityState: string };
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    const timersWhileHidden = vi.getTimerCount();
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(timersWhileHidden - 1);
    expect(spies.onBatch).not.toHaveBeenCalled();
  });
});

describe("useHighFrequencyWs — 心跳與重連", () => {
  it("pong 逾時 → close → 退避後重連", () => {
    const { spies } = mount({ heartbeatMs: 1_000, pongTimeoutMs: 500 });
    const first = FakeWebSocket.latest();
    first.serverOpen();
    first.serverSend({ type: "system/connected", clientId: "c1" });

    vi.advanceTimersByTime(1_000);
    expect(first.sent).toContainEqual({ type: "ping" });
    vi.advanceTimersByTime(500); // 未回 pong
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(spies.onStatus).toHaveBeenLastCalledWith("reconnecting");

    vi.advanceTimersByTime(1_000); // attempt 0 的退避（抖動已歸零）
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("有回 pong 則不重連，並回報 RTT", () => {
    const onLatency = vi.fn();
    mount({ heartbeatMs: 1_000, pongTimeoutMs: 500, onLatency });
    const ws = FakeWebSocket.latest();
    ws.serverOpen();
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(30);
    ws.serverSend({ type: "pong", ts: 0 });
    vi.advanceTimersByTime(1_000);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    expect(onLatency).toHaveBeenCalledWith(30);
  });

  it("重連後收到新的 system/connected → 再次 onConnected，App 據此重訂閱", () => {
    const { handle, spies } = mount({
      onConnected: vi.fn((clientId: string) => {
        handle.send({ type: "machine/subscribe", token: "", machineIds: [clientId] });
      }),
    });
    const first = FakeWebSocket.latest();
    first.serverOpen();
    first.serverSend({ type: "system/connected", clientId: "c1" });
    first.close(); // 伺服器端斷線

    vi.advanceTimersByTime(1_000);
    const second = FakeWebSocket.latest();
    expect(second).not.toBe(first);
    second.serverOpen();
    second.serverSend({ type: "system/connected", clientId: "c2" });

    expect(first.sent).toContainEqual({ type: "machine/subscribe", token: "", machineIds: ["c1"] });
    expect(second.sent).toContainEqual({ type: "machine/subscribe", token: "", machineIds: ["c2"] });
    expect(spies.onStatus).toHaveBeenLastCalledWith("connected");
  });

  it("連上後立刻被關（沒收到 system/connected）退避不歸零，延遲持續加長", () => {
    mount();
    FakeWebSocket.latest().close(); // attempt 0 → 1s
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const second = FakeWebSocket.latest();
    second.serverOpen(); // open 了但伺服器馬上關
    second.close(); // attempt 1 → 2s
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("pong 逾時後、舊 socket 的 close 尚未到達就 online 重連 → 舊心跳不會關掉新 socket", () => {
    mount({ heartbeatMs: 1_000, pongTimeoutMs: 500 });
    const first = FakeWebSocket.latest();
    first.serverOpen();
    // 模擬真實瀏覽器：close() 只進 CLOSING，close 事件稍後才到
    vi.spyOn(first, "close").mockImplementation(() => {
      first.readyState = FakeWebSocket.CLOSING;
    });
    vi.advanceTimersByTime(1_000 + 500); // ping 後未回 pong → 呼叫 close()，但事件未到
    expect(first.readyState).toBe(FakeWebSocket.CLOSING);

    windowTarget.dispatchEvent(new Event("online"));
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.latest();

    vi.advanceTimersByTime(1_000 + 500);
    expect(second.readyState).not.toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("window online 事件 → 不等退避計時器，立即重連", () => {
    mount();
    FakeWebSocket.latest().close();
    expect(FakeWebSocket.instances).toHaveLength(1);
    windowTarget.dispatchEvent(new Event("online"));
    expect(FakeWebSocket.instances).toHaveLength(2);
    // 原本排定的退避計時器已取消，不會再多開一條
    vi.advanceTimersByTime(5_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe("useHighFrequencyWs — 卸載清理", () => {
  it("scope 結束 → timer／rAF／socket 全清，回報 disconnected，之後不再重連", () => {
    const { spies } = mount({ heartbeatMs: 1_000 });
    const ws = FakeWebSocket.latest();
    ws.serverOpen();
    ws.serverSend([pt("a")]);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // rAF + 心跳

    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    expect(spies.onStatus).toHaveBeenLastCalledWith("disconnected");

    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(spies.onBatch).not.toHaveBeenCalled(); // 卸載時 buffer 一併丟棄

    windowTarget.dispatchEvent(new Event("online")); // listener 已移除
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
