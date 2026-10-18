// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import StreamingPanel from "./StreamingPanel.vue";

/**
 * StreamingPanel 貼底捲動（WEB-17）：token 逐則抵達時，scrollTop 一幀至多寫一次；
 * 使用者上捲後不強拉；卸載時取消未執行的幀。
 */

/** 收集 requestAnimationFrame 回呼（可被 cancelAnimationFrame 取消），手動逐幀推進。 */
let frames: { id: number; cb: FrameRequestCallback }[] = [];
let frameSeq = 0;
function nextFrame(): void {
  const pending = frames;
  frames = [];
  for (const { cb } of pending) cb(performance.now());
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frameSeq += 1;
    frames.push({ id: frameSeq, cb });
    return frameSeq;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames = frames.filter((f) => f.id !== id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 掛上面板，並把捲動區的尺寸與 scrollTop 換成可控的假值（happy-dom 不做 layout）。 */
function mountPanel() {
  const w = mount(StreamingPanel, { props: { text: "", streaming: true } });
  const el = w.find('[aria-label="原始串流"]').element as HTMLElement;
  let scrollTop = 0;
  let scrollHeight = 100;
  const writes: number[] = [];
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 100 });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
      writes.push(v);
    },
  });
  return {
    w,
    el,
    writes,
    setScrollHeight: (h: number) => {
      scrollHeight = h;
    },
    /** 模擬使用者捲動（直接改值，不算程式寫入）。 */
    userScrollTo: (top: number) => {
      scrollTop = top;
    },
  };
}

describe("StreamingPanel 貼底捲動", () => {
  it("同一幀內多則 token 只寫一次 scrollTop，且寫入時已是最新高度", async () => {
    const { w, writes, setScrollHeight } = mountPanel();
    for (const [i, text] of ["a", "ab", "abc", "abcd"].entries()) {
      setScrollHeight(200 + i * 10);
      await w.setProps({ text });
    }
    expect(writes).toEqual([]); // 幀到之前不碰 scrollTop
    expect(frames).toHaveLength(1); // 只排一個幀
    nextFrame();
    expect(writes).toEqual([230]);

    // 下一幀的新 token 再寫一次。
    setScrollHeight(300);
    await w.setProps({ text: "abcde" });
    nextFrame();
    expect(writes).toEqual([230, 300]);
  });

  it("使用者上捲後不強拉；捲回底部後恢復跟隨", async () => {
    const { w, el, writes, setScrollHeight, userScrollTo } = mountPanel();
    setScrollHeight(500);
    userScrollTo(100); // 距底 300px → 不貼底
    await w.find('[aria-label="原始串流"]').trigger("scroll");
    await w.setProps({ text: "新 token" });
    expect(frames).toHaveLength(0);
    nextFrame();
    expect(writes).toEqual([]);

    userScrollTo(400); // 回到底部（500 - 400 - 100 = 0）
    el.dispatchEvent(new Event("scroll"));
    await w.setProps({ text: "新 token 再一則" });
    nextFrame();
    expect(writes).toEqual([500]);
  });

  it("排程後、幀到之前使用者上捲：該幀不強拉", async () => {
    const { w, el, writes, setScrollHeight, userScrollTo } = mountPanel();
    setScrollHeight(500);
    await w.setProps({ text: "token" });
    expect(frames).toHaveLength(1);
    userScrollTo(0);
    el.dispatchEvent(new Event("scroll"));
    nextFrame();
    expect(writes).toEqual([]);
  });

  it("卸載時取消未執行的幀", async () => {
    const { w } = mountPanel();
    await w.setProps({ text: "token" });
    expect(frames).toHaveLength(1);
    w.unmount();
    expect(frames).toHaveLength(0);
  });
});
