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

  it("noteProgress 單調遞增：較小的 attempt／execution（雙重執行時舊的那次晚到）不覆寫較大的值", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    registry.noteProgress(JOB_ID, 2, 3);
    registry.noteProgress(JOB_ID, 1, 1);
    expect(registry.get(JOB_ID)).toMatchObject({ attempt: 2, execution: 3 });
    registry.noteProgress(JOB_ID, 2, 4);
    expect(registry.get(JOB_ID)).toMatchObject({ attempt: 2, execution: 4 });
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

const CLIENT_C = "3f4e5d6c-7b8a-4c9d-8e1f-2a3b4c5d6e7f";
/** 在線的 clientId 集合。 */
const onlineOf = (...ids: string[]) => {
  const set = new Set(ids);
  return (clientId: string) => set.has(clientId);
};

describe("JobRoutingRegistry.claimForLookup（data-model §2.3 六列）", () => {
  it("第 1 列：無綁定 → created，以 machineId null 暫定綁定到本 socket", () => {
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: onlineOf(CLIENT_B) });
    expect(claim).toEqual({
      kind: "created",
      jobId: JOB_ID,
      socketId: CLIENT_B,
      binding: { clientId: CLIENT_B, machineId: null, boundAt: T0 },
    });
    expect(claim.kind === "created" && claim.binding).toBe(registry.get(JOB_ID));
  });

  it.each(["completed", "failed"] as const)("第 2 列：綁定已標 %s → terminal，不動（即使原連線離線）", (kind) => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    registry.markTerminal(JOB_ID, kind);
    const before = registry.get(JOB_ID);
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: onlineOf(CLIENT_B) });
    expect(claim).toEqual({ kind: "terminal", jobId: JOB_ID, socketId: CLIENT_B });
    expect(registry.get(JOB_ID)).toBe(before);
  });

  it("第 3 列：綁定就是本 socket → unchanged，不動", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    const before = registry.get(JOB_ID);
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_A, isOnline: onlineOf(CLIENT_A) });
    expect(claim).toEqual({ kind: "unchanged", jobId: JOB_ID, socketId: CLIENT_A });
    expect(registry.get(JOB_ID)).toBe(before);
  });

  it("第 4 列：原連線離線 → rebound（viaPreviousSocketId false），改綁並更新 boundAt", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    const original = registry.get(JOB_ID);
    vi.advanceTimersByTime(1_000);
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: onlineOf(CLIENT_B) });
    expect(claim).toMatchObject({ kind: "rebound", socketId: CLIENT_B, viaPreviousSocketId: false });
    expect(claim.kind === "rebound" && claim.previous).toBe(original);
    expect(registry.get(JOB_ID)).toMatchObject({ clientId: CLIENT_B, machineId: "cnc-01", boundAt: T0 + 1_000 });
    expect(claim.kind === "rebound" && claim.binding).toBe(registry.get(JOB_ID));
  });

  it("第 4 列優先於第 5 列：原連線離線且等於 previousSocketId → viaPreviousSocketId false", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    const claim = registry.claimForLookup({
      jobId: JOB_ID,
      socketId: CLIENT_B,
      previousSocketId: CLIENT_A,
      isOnline: onlineOf(CLIENT_B),
    });
    expect(claim).toMatchObject({ kind: "rebound", viaPreviousSocketId: false });
  });

  it("第 5 列：原連線仍在線但等於 previousSocketId → rebound（viaPreviousSocketId true），只改綁、不碰舊連線", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    const isOnline = vi.fn(onlineOf(CLIENT_A, CLIENT_B));
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, previousSocketId: CLIENT_A, isOnline });
    expect(claim).toMatchObject({ kind: "rebound", viaPreviousSocketId: true });
    expect(registry.owner(JOB_ID)).toBe(CLIENT_B);
    // registry 不依賴 Gateway：對舊連線只做在線查詢，不終止它。
    expect(isOnline).toHaveBeenCalledWith(CLIENT_A);
  });

  it("第 6 列：原連線在線、不是本 socket、不等於 previousSocketId → conflict，不動", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    const before = registry.get(JOB_ID);
    for (const previousSocketId of [undefined, CLIENT_C]) {
      const claim = registry.claimForLookup({
        jobId: JOB_ID,
        socketId: CLIENT_B,
        previousSocketId,
        isOnline: onlineOf(CLIENT_A, CLIENT_B),
      });
      expect(claim).toEqual({ kind: "conflict", jobId: JOB_ID, socketId: CLIENT_B, ownerClientId: CLIENT_A });
    }
    expect(registry.get(JOB_ID)).toBe(before);
  });
});

describe("JobRoutingRegistry.resolveClaim／markDeferred（P1）", () => {
  it("created 後補上 machineId（就地改寫，參照不變）；期間無擱置 → deferred false", () => {
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: () => true });
    const before = registry.get(JOB_ID);
    expect(registry.resolveClaim(claim, "cnc-01")).toEqual({ deferred: false });
    expect(registry.get(JOB_ID)).toBe(before);
    expect(registry.get(JOB_ID)?.machineId).toBe("cnc-01");
  });

  it("期間 relay 有擱置（markDeferred 就地改寫）→ deferred true，並清掉旗標", () => {
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: () => true });
    const before = registry.get(JOB_ID);
    registry.markDeferred(JOB_ID);
    expect(registry.get(JOB_ID)).toBe(before);
    expect(registry.get(JOB_ID)?.deferred).toBe(true);
    expect(registry.resolveClaim(claim, "cnc-01")).toEqual({ deferred: true });
    expect(registry.get(JOB_ID)).not.toHaveProperty("deferred");
  });

  it("期間已被標終態（換成副本）→ 仍補上副本的 machineId 並回報 deferred，副本照寬限刪", () => {
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: () => true });
    registry.markDeferred(JOB_ID);
    registry.markTerminal(JOB_ID, "completed");
    expect(registry.resolveClaim(claim, "cnc-01")).toEqual({ deferred: true });
    expect(registry.get(JOB_ID)).toMatchObject({ machineId: "cnc-01", terminal: { kind: "completed" } });
    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS);
    expect(registry.isBound(JOB_ID)).toBe(false);
  });

  it("綁定已有 machineId、已不存在、或已改送別的連線 → 不動、deferred false", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    const unchanged = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_A, isOnline: () => true });
    expect(registry.resolveClaim(unchanged, "press-02")).toEqual({ deferred: false });
    expect(registry.get(JOB_ID)?.machineId).toBe("cnc-01");

    const created = registry.claimForLookup({ jobId: OTHER_JOB_ID, socketId: CLIENT_B, isOnline: () => true });
    registry.delete(OTHER_JOB_ID);
    expect(registry.resolveClaim(created, "cnc-02")).toEqual({ deferred: false });
    expect(registry.isBound(OTHER_JOB_ID)).toBe(false);

    const again = registry.claimForLookup({ jobId: OTHER_JOB_ID, socketId: CLIENT_B, isOnline: () => true });
    registry.bind(OTHER_JOB_ID, CLIENT_A, null); // 他人改綁
    expect(registry.resolveClaim(again, "cnc-02")).toEqual({ deferred: false });
    expect(registry.get(OTHER_JOB_ID)?.machineId).toBeNull();
  });

  it("markDeferred 無綁定時不動", () => {
    registry.markDeferred(JOB_ID);
    expect(registry.isBound(JOB_ID)).toBe(false);
  });
});

describe("JobRoutingRegistry.revertClaim（只撤回自己的那份）", () => {
  it("created：目前仍是自己建立的那份（含已 resolveClaim 就地補 machineId）→ 刪除", () => {
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: () => true });
    registry.resolveClaim(claim, "cnc-01");
    registry.revertClaim(claim);
    expect(registry.isBound(JOB_ID)).toBe(false);
  });

  it("created：期間被他人重新綁定 → 不刪別人的綁定", () => {
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: () => true });
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    registry.revertClaim(claim);
    expect(registry.owner(JOB_ID)).toBe(CLIENT_A);
  });

  it("created：期間已被標終態 → 不刪，交給寬限計時器", () => {
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: () => true });
    registry.markTerminal(JOB_ID, "failed");
    registry.revertClaim(claim);
    expect(registry.get(JOB_ID)?.terminal?.kind).toBe("failed");
    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS);
    expect(registry.isBound(JOB_ID)).toBe(false);
  });

  it("rebound：還原原 clientId 與 boundAt，保留改綁期間記下的 attempt／execution", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    vi.advanceTimersByTime(1_000);
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: () => false });
    registry.noteProgress(JOB_ID, 2, 3);
    registry.revertClaim(claim);
    expect(registry.get(JOB_ID)).toEqual({
      clientId: CLIENT_A,
      machineId: "cnc-01",
      boundAt: T0,
      attempt: 2,
      execution: 3,
    });
  });

  it("rebound：期間已被他人再改綁 → 不還原", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: () => false });
    registry.rebind(JOB_ID, CLIENT_C);
    registry.revertClaim(claim);
    expect(registry.owner(JOB_ID)).toBe(CLIENT_C);
  });

  it.each(["completed", "failed"] as const)("rebound：撤回時綁定已被標 %s → 不還原原綁定，照寬限刪", (kind) => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: () => false });
    registry.markTerminal(JOB_ID, kind);
    registry.revertClaim(claim);
    expect(registry.get(JOB_ID)).toMatchObject({ clientId: CLIENT_B, terminal: { kind } });
    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS);
    expect(registry.isBound(JOB_ID)).toBe(false);
  });

  it("unchanged／terminal／conflict → no-op", () => {
    registry.bind(JOB_ID, CLIENT_A, "cnc-01");
    const before = registry.get(JOB_ID);
    const unchanged = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_A, isOnline: () => true });
    const conflict = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: () => true });
    registry.revertClaim(unchanged);
    registry.revertClaim(conflict);
    expect(registry.get(JOB_ID)).toBe(before);

    registry.markTerminal(JOB_ID, "completed");
    const terminalBefore = registry.get(JOB_ID);
    const terminal = registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_B, isOnline: () => true });
    registry.revertClaim(terminal);
    expect(registry.get(JOB_ID)).toBe(terminalBefore);
  });
});
