import { describe, expect, it } from "vitest";
import { bannerOf } from "./status-banner.js";

const T = Date.parse("2026-10-17T03:04:05.000Z");

describe("bannerOf（主區連線／授權／暫停橫幅）", () => {
  it("連線正常、已授權、未暫停：不顯示橫幅", () => {
    expect(bannerOf("connected", true, null, false, null)).toBeNull();
  });

  it("首次連線前為中性「連線中…」；曾連上後斷線為 crit「已斷線…」", () => {
    expect(bannerOf("disconnected", false, null, false, null)).toEqual({
      text: "連線中…",
      cls: "border-edge bg-surface/72 text-ink-2",
    });
    expect(bannerOf("disconnected", true, null, false, null)?.cls).toBe("border-crit bg-crit-bg text-crit-fg");
  });

  it("重新連線中為 warn 橫幅", () => {
    expect(bannerOf("reconnecting", true, null, false, null)).toEqual({
      text: "重新連線中…（畫面保留最後已知資料）",
      cls: "border-warn bg-warn-bg text-warn-fg",
    });
  });

  it("連線正常但未授權：顯示授權錯誤原文（crit）", () => {
    expect(bannerOf("connected", true, "未授權：token 無效", false, null)).toEqual({
      text: "未授權：token 無效",
      cls: "border-crit bg-crit-bg text-crit-fg",
    });
  });

  it("暫停：中性玻璃橫幅帶 pausedAt（「暫停於 HH:mm:ss」的來源）", () => {
    expect(bannerOf("connected", true, null, true, T)).toEqual({
      text: "已暫停畫面更新",
      cls: "border-edge bg-surface/72 text-ink",
      pausedAt: T,
    });
  });

  it("暫停但 pausedAt 缺值：不顯示（不出現半截句子）", () => {
    expect(bannerOf("connected", true, null, true, null)).toBeNull();
  });

  it("優先序：斷線 ＞ 未授權 ＞ 暫停", () => {
    expect(bannerOf("reconnecting", true, "未授權", true, T)?.text).toBe("重新連線中…（畫面保留最後已知資料）");
    expect(bannerOf("disconnected", true, "未授權", true, T)?.text).toBe("已斷線，畫面保留最後已知資料，可能已過時");
    expect(bannerOf("disconnected", false, null, true, T)?.text).toBe("連線中…");
    expect(bannerOf("connected", true, "未授權", true, T)?.text).toBe("未授權");
    expect(bannerOf("connected", true, "未授權", true, T)?.pausedAt).toBeUndefined();
  });
});
