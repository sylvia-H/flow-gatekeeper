import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 結構化 logger 換成替身：斷言孤兒回收的 warn，也避免測試期間建立真 pino 實例。
const plog = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
vi.mock("../../logging/app-logger.js", () => ({
  getAppLogger: () => ({ child: () => plog }),
}));

const { JobRoutingRegistry, ORPHAN_SWEEP_INTERVAL_MS, ORPHAN_TTL_MS, TERMINAL_BINDING_GRACE_MS } = await import(
  "./job-routing-registry.js"
);

const JOB_ID = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";
const OTHER_JOB_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const CLIENT_A = "5b1f9c1e-8a53-4c43-9f0e-2d1c3b4a5e6f";
const CLIENT_B = "7c2e4d6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f";
const T0 = new Date("2026-10-21T00:00:00Z").getTime();

let registry: InstanceType<typeof JobRoutingRegistry>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  registry = new JobRoutingRegistry();
});

afterEach(() => {
  registry.onModuleDestroy();
  vi.useRealTimers();
  plog.warn.mockClear();
});

describe("JobRoutingRegistry：bind／get／owner／isBound／delete", () => {
  it("bind 後 get 回完整綁定（boundAt 為現在）、owner 回 clientId、isBound 為真", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    expect(registry.get(JOB_ID)).toEqual({ clientId: CLIENT_A, machineId: "cnc-01", boundAt: T0 });
    expect(registry.owner(JOB_ID)).toBe(CLIENT_A);
    expect(registry.isBound(JOB_ID)).toBe(true);
  });

  it("無綁定 → get／owner 回 undefined、isBound 為假", () => {
    expect(registry.get(JOB_ID)).toBeUndefined();
    expect(registry.owner(JOB_ID)).toBeUndefined();
    expect(registry.isBound(JOB_ID)).toBe(false);
  });

  it("machineId 可為 null（GET 暫定綁定，P1）", () => {
    registry.bind(JOB_ID, CLIENT_A, null);
    expect(registry.get(JOB_ID)?.machineId).toBeNull();
  });

  it("delete 只刪指定 jobId", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    registry.bind(OTHER_JOB_ID, CLIENT_B, "cnc-02");
    registry.delete(JOB_ID);
    expect(registry.isBound(JOB_ID)).toBe(false);
    expect(registry.owner(OTHER_JOB_ID)).toBe(CLIENT_B);
  });

  it("noteProgress 就地記下 attempt／execution（不換物件），未給的欄位不覆蓋；無綁定時不動", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    const before = registry.get(JOB_ID);
    registry.noteProgress(JOB_ID, 2, 3);
    registry.noteProgress(JOB_ID, undefined, 4);
    expect(registry.get(JOB_ID)).toBe(before);
    expect(registry.get(JOB_ID)).toMatchObject({ attempt: 2, execution: 4 });
    registry.noteProgress(OTHER_JOB_ID, 1, 1);
    expect(registry.isBound(OTHER_JOB_ID)).toBe(false);
  });
});

describe("JobRoutingRegistry.markTerminal（AR-5、D12）", () => {
  it.each(["completed", "failed"] as const)("%s：立即標 terminal，綁定保留到寬限期滿（恰差 1 ms 仍在）才刪", (kind) => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    registry.markTerminal(JOB_ID, kind);
    expect(registry.get(JOB_ID)).toMatchObject({ clientId: CLIENT_A, terminal: { kind, at: T0 } });
    expect(registry.owner(JOB_ID)).toBe(CLIENT_A); // 寬限內 ai/* 照常查得到原連線

    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS - 1);
    expect(registry.isBound(JOB_ID)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(registry.isBound(JOB_ID)).toBe(false);
  });

  it("以新物件取代舊綁定（撤回以參照比對時才認得出已標終態），可指定 now", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    const before = registry.get(JOB_ID);
    registry.markTerminal(JOB_ID, "failed", T0 + 123);
    expect(registry.get(JOB_ID)).not.toBe(before);
    expect(registry.get(JOB_ID)?.terminal).toEqual({ kind: "failed", at: T0 + 123 });
  });

  it("無綁定 → 不動、不排計時器", () => {
    registry.markTerminal(JOB_ID, "completed");
    expect(registry.isBound(JOB_ID)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("寬限計時器 unref，不阻止行程結束", () => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: () => void, ms?: number) => {
      const t = realSetTimeout(fn, ms);
      if (ms === TERMINAL_BINDING_GRACE_MS) timers.push(t);
      return t;
    });
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    registry.markTerminal(JOB_ID, "completed");
    spy.mockRestore();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.hasRef()).toBe(false);
  });

  it("寬限內同 jobId 重新 bind → 舊計時器期滿不誤刪新綁定", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    registry.markTerminal(JOB_ID, "completed");
    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS / 2);
    registry.bind(JOB_ID, CLIENT_B, "cnc-02");
    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS);
    expect(registry.get(JOB_ID)).toMatchObject({ clientId: CLIENT_B, machineId: "cnc-02" });
    expect(registry.get(JOB_ID)?.terminal).toBeUndefined();
  });

  it("寬限內被刪後又以同 jobId 重新綁定 → 期滿不誤刪新綁定", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    registry.markTerminal(JOB_ID, "failed");
    registry.delete(JOB_ID); // 例如孤兒回收
    registry.bind(JOB_ID, CLIENT_B, "cnc-02");
    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS);
    expect(registry.owner(JOB_ID)).toBe(CLIENT_B);
  });

  it.each(["completed", "failed"] as const)(
    "%s 寬限內 rebind → 回 undefined、綁定原樣不動（data-model §2.3 第 2 列），期滿照刪",
    (kind) => {
      registry.bind(JOB_ID, CLIENT_A, "cnc-01");
      registry.markTerminal(JOB_ID, kind);
      const terminal = registry.get(JOB_ID);
      expect(registry.rebind(JOB_ID, CLIENT_B)).toBeUndefined();
      expect(registry.get(JOB_ID)).toBe(terminal);
      expect(registry.owner(JOB_ID)).toBe(CLIENT_A);
      vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS);
      expect(registry.isBound(JOB_ID)).toBe(false);
    },
  );

  it("同 jobId 再次 markTerminal → 寬限自最後一次起算（舊計時器作廢）", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    registry.markTerminal(JOB_ID, "completed");
    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS - 1);
    registry.markTerminal(JOB_ID, "completed");
    vi.advanceTimersByTime(1);
    expect(registry.isBound(JOB_ID)).toBe(true);
    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS - 1);
    expect(registry.isBound(JOB_ID)).toBe(false);
  });
});

describe("JobRoutingRegistry.rebind（P23）", () => {
  it("回傳被取代的舊綁定，新綁定換 clientId、boundAt 更新為現在，其餘欄位沿用", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    registry.noteProgress(JOB_ID, 1, 2);
    const original = registry.get(JOB_ID);
    vi.advanceTimersByTime(5 * 60_000);

    const previous = registry.rebind(JOB_ID, CLIENT_B);
    expect(previous).toBe(original);
    expect(previous).toMatchObject({ clientId: CLIENT_A, boundAt: T0 });
    expect(registry.get(JOB_ID)).toEqual({
      clientId: CLIENT_B,
      machineId: "cnc-01",
      boundAt: T0 + 5 * 60_000,
      attempt: 1,
      execution: 2,
    });
    expect(registry.get(JOB_ID)).not.toBe(original);
  });

  it("無綁定 → 回 undefined、不建立綁定", () => {
    expect(registry.rebind(JOB_ID, CLIENT_B)).toBeUndefined();
    expect(registry.isBound(JOB_ID)).toBe(false);
  });
});

describe("JobRoutingRegistry 孤兒回收", () => {
  it("sweepOrphans：自 boundAt 起超過 10 分鐘才回收（恰等於不回收），回傳 jobId 並記 warn", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    registry.bind(OTHER_JOB_ID, CLIENT_B, "cnc-02", T0 + 1);
    expect(registry.sweepOrphans(T0 + ORPHAN_TTL_MS)).toEqual([]);
    expect(registry.isBound(JOB_ID)).toBe(true);
    expect(plog.warn).not.toHaveBeenCalled();

    expect(registry.sweepOrphans(T0 + ORPHAN_TTL_MS + 1)).toEqual([JOB_ID]);
    expect(registry.isBound(JOB_ID)).toBe(false);
    expect(registry.isBound(OTHER_JOB_ID)).toBe(true);
    expect(plog.warn).toHaveBeenCalledTimes(1);
    expect(plog.warn).toHaveBeenCalledWith({ jobId: JOB_ID }, "swept orphan job binding");
  });

  it("rebind 後自改綁時刻重新起算：原始建立已逾 10 分鐘也不回收", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    vi.advanceTimersByTime(ORPHAN_TTL_MS - 1);
    registry.rebind(JOB_ID, CLIENT_B);
    expect(registry.sweepOrphans(T0 + ORPHAN_TTL_MS + 1)).toEqual([]);
    expect(registry.sweepOrphans(T0 + 2 * ORPHAN_TTL_MS)).toEqual([JOB_ID]);
  });

  it("onModuleInit 每 60 秒自動掃描：t = 10 分鐘不回收、t = 11 分鐘回收", () => {
    registry.onModuleInit();
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    vi.advanceTimersByTime(ORPHAN_TTL_MS);
    expect(registry.isBound(JOB_ID)).toBe(true);
    vi.advanceTimersByTime(ORPHAN_SWEEP_INTERVAL_MS);
    expect(registry.isBound(JOB_ID)).toBe(false);
    expect(plog.warn).toHaveBeenCalledWith({ jobId: JOB_ID }, "swept orphan job binding");
  });
});

describe("JobRoutingRegistry.onModuleDestroy", () => {
  it("清掉孤兒回收 interval 與所有寬限計時器；之後推時間不再刪綁定", () => {
    registry.onModuleInit();
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    registry.bind(OTHER_JOB_ID, CLIENT_B, "cnc-02");
    registry.markTerminal(OTHER_JOB_ID, "failed");
    expect(vi.getTimerCount()).toBe(2);

    registry.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(ORPHAN_TTL_MS + ORPHAN_SWEEP_INTERVAL_MS);
    expect(registry.isBound(JOB_ID)).toBe(true);
    expect(registry.isBound(OTHER_JOB_ID)).toBe(true);
  });
});
