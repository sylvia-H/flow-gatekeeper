import { describe, expect, it } from "vitest";
import { BoundedBuffer, LogThrottle, SingleFlight, withDeadline } from "./telemetry-buffer.js";

describe("BoundedBuffer", () => {
  it("未滿時全數保留、drain 依放入順序取出並清空", () => {
    const buf = new BoundedBuffer<number>(5);
    expect(buf.push([1, 2])).toBe(0);
    expect(buf.push([3])).toBe(0);
    expect(buf.size).toBe(3);
    expect(buf.drain()).toEqual([1, 2, 3]);
    expect(buf.size).toBe(0);
    expect(buf.drain()).toEqual([]);
  });

  it("超出容量丟最舊，回傳丟棄筆數", () => {
    const buf = new BoundedBuffer<number>(3);
    buf.push([1, 2]);
    expect(buf.push([3, 4, 5])).toBe(2);
    expect(buf.drain()).toEqual([3, 4, 5]);
  });

  it("單批就超過容量時只留最新的 capacity 筆", () => {
    const buf = new BoundedBuffer<number>(2);
    expect(buf.push([1, 2, 3, 4])).toBe(2);
    expect(buf.drain()).toEqual([3, 4]);
  });

  it("unshift 放回隊首；超量時放回的（最舊）先被丟", () => {
    const buf = new BoundedBuffer<number>(4);
    buf.push([10, 11, 12]);
    expect(buf.unshift([1, 2])).toBe(1);
    expect(buf.drain()).toEqual([2, 10, 11, 12]);
  });

  it("空批次不影響狀態", () => {
    const buf = new BoundedBuffer<number>(1);
    expect(buf.push([])).toBe(0);
    expect(buf.unshift([])).toBe(0);
    expect(buf.size).toBe(0);
  });

  it("容量必須是正整數", () => {
    expect(() => new BoundedBuffer<number>(0)).toThrow(RangeError);
    expect(() => new BoundedBuffer<number>(1.5)).toThrow(RangeError);
  });
});

describe("LogThrottle", () => {
  it("同 key 在間隔內只放行第一則，下次放行時回報被壓掉的次數", () => {
    const t = new LogThrottle(30_000);
    expect(t.hit("telemetry", 0)).toEqual({ suppressed: 0 });
    expect(t.hit("telemetry", 1_000)).toBeNull();
    expect(t.hit("telemetry", 29_999)).toBeNull();
    expect(t.hit("telemetry", 30_000)).toEqual({ suppressed: 2 });
    // 放行後計數歸零、重新計時
    expect(t.hit("telemetry", 30_001)).toBeNull();
    expect(t.hit("telemetry", 60_000)).toEqual({ suppressed: 1 });
  });

  it("不同 key 各自節流", () => {
    const t = new LogThrottle(30_000);
    expect(t.hit("telemetry", 0)).not.toBeNull();
    expect(t.hit("errorlogs", 10)).not.toBeNull();
    expect(t.hit("telemetry", 20)).toBeNull();
  });
});

describe("SingleFlight", () => {
  it("進行中再呼叫不會並發執行第二個 task", async () => {
    const sf = new SingleFlight();
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const task = async (): Promise<void> => {
      calls += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gate;
      running -= 1;
    };

    const a = sf.run(task);
    const b = sf.run(task);
    const c = sf.run(task);
    expect(sf.busy).toBe(true);
    release();
    await Promise.all([a, b, c]);

    expect(calls).toBe(1);
    expect(maxRunning).toBe(1);
    expect(sf.busy).toBe(false);
  });

  it("前一個結束後可以再跑下一個；idle() 等進行中者結束且不拋出", async () => {
    const sf = new SingleFlight();
    let calls = 0;
    await sf.run(async () => {
      calls += 1;
    });
    const failing = sf.run(async () => {
      calls += 1;
      throw new Error("boom");
    });
    await expect(sf.idle()).resolves.toBeUndefined();
    await expect(failing).rejects.toThrow("boom");
    expect(sf.busy).toBe(false);
    await sf.run(async () => {
      calls += 1;
    });
    expect(calls).toBe(3);
  });

  it("task 同步 throw 後不會卡死：該次 reject、之後仍可再 run", async () => {
    const sf = new SingleFlight();
    const syncThrow = (): Promise<void> => {
      throw new Error("sync boom");
    };
    await expect(sf.run(syncThrow)).rejects.toThrow("sync boom");
    expect(sf.busy).toBe(false);
    let ran = false;
    await sf.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe("withDeadline", () => {
  it("時限內完成回 true（reject 也算完成、不外拋）", async () => {
    await expect(withDeadline(Promise.resolve(1), 1_000)).resolves.toBe(true);
    await expect(withDeadline(Promise.reject(new Error("x")), 1_000)).resolves.toBe(true);
  });

  it("逾時回 false；時限 ≤0 直接回 false", async () => {
    const never = new Promise<void>(() => undefined);
    await expect(withDeadline(never, 20)).resolves.toBe(false);
    await expect(withDeadline(Promise.resolve(), 0)).resolves.toBe(false);
  });
});
