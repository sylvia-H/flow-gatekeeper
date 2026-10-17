// @vitest-environment happy-dom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { TelemetryPoint } from "@flow-gatekeeper/contracts";
import FlowLink from "./FlowLink.vue";
import StageTopology from "./StageTopology.vue";
import { useMonitoringStore } from "../stores/monitoring.store.js";
import type { FlowSpeed } from "../lib/flow-link.js";

/**
 * FlowLink（T038；FR-014、FR-016、research R5）：速度等級映射到 `data-speed` 與動畫時長、
 * 垂直模式與 reduced-motion 下為 `none`、整個 svg 為裝飾（aria-hidden）。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountLink(props: { width: number; speed: FlowSpeed; orientation?: "horizontal" | "vertical" }) {
  return mount(FlowLink, { props });
}

/** 上層流動虛線（第二條 line）。 */
const flowLine = (w: ReturnType<typeof mountLink>) => w.findAll("line")[1]!;

describe("FlowLink 速度等級（FR-014）", () => {
  it.each([
    ["slow", "2.4s"],
    ["mid", "1.2s"],
    ["fast", "0.6s"],
  ] as const)("speed=%s → data-speed=%s、虛線掛 animate-flow 且時長為 %s", (speed, duration) => {
    const w = mountLink({ width: 5, speed });
    expect(w.get("svg").attributes("data-fg")).toBe("flow-link");
    expect(w.get("svg").attributes("data-speed")).toBe(speed);
    const line = flowLine(w);
    expect(line.classes()).toContain("animate-flow");
    expect(line.attributes("style")).toContain(`animation-duration: ${duration}`);
  });

  it("三檔時長由慢到快遞減（等級越高流得越快）", () => {
    const seconds = (["slow", "mid", "fast"] as const).map((speed) => {
      const style = flowLine(mountLink({ width: 5, speed })).attributes("style") ?? "";
      return Number(/animation-duration:\s*([\d.]+)s/.exec(style)?.[1]);
    });
    expect(seconds[0]).toBeGreaterThan(seconds[1]!);
    expect(seconds[1]).toBeGreaterThan(seconds[2]!);
  });

  it("speed=none → data-speed=none、不掛 animate-flow、無動畫時長", () => {
    const w = mountLink({ width: 2, speed: "none" });
    expect(w.get("svg").attributes("data-speed")).toBe("none");
    expect(flowLine(w).classes()).not.toContain("animate-flow");
    expect(flowLine(w).attributes("style")).toBeUndefined();
  });

  it("stroke-width 由 width props 決定（底線與流動虛線同寬）", () => {
    const w = mountLink({ width: 6.5, speed: "mid" });
    for (const line of w.findAll("line")) expect(line.attributes("stroke-width")).toBe("6.5");
  });

  it("顏色只用語意 class：底線 stroke-etch、虛線 stroke-ink-3、箭頭 fill-ink-3", () => {
    const w = mountLink({ width: 5, speed: "slow" });
    const [base, flow] = w.findAll("line");
    expect(base!.classes()).toContain("stroke-etch");
    expect(flow!.classes()).toContain("stroke-ink-3");
    expect(w.get("polygon").classes()).toContain("fill-ink-3");
    expect(w.html()).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe("FlowLink 垂直模式（FR-016）", () => {
  it.each(["slow", "mid", "fast"] as const)("orientation=vertical 時 speed=%s 仍強制為 none、無動畫", (speed) => {
    const w = mountLink({ width: 8, speed, orientation: "vertical" });
    expect(w.get("svg").attributes("data-speed")).toBe("none");
    expect(w.get("svg").attributes("data-orientation")).toBe("vertical");
    expect(flowLine(w).classes()).not.toContain("animate-flow");
    // 粗細照常
    expect(flowLine(w).attributes("stroke-width")).toBe("8");
  });

  it("垂直時線段沿 y 軸、箭頭尖端朝下；水平時沿 x 軸、尖端朝右", () => {
    const v = mountLink({ width: 4, speed: "none", orientation: "vertical" });
    const vl = flowLine(v);
    expect(vl.attributes("x1")).toBe(vl.attributes("x2"));
    expect(Number(vl.attributes("y2"))).toBeGreaterThan(Number(vl.attributes("y1")));
    expect(v.get("polygon").attributes("points")).toContain("12,24");

    const h = mountLink({ width: 4, speed: "none" });
    const hl = flowLine(h);
    expect(hl.attributes("y1")).toBe(hl.attributes("y2"));
    expect(Number(hl.attributes("x2"))).toBeGreaterThan(Number(hl.attributes("x1")));
    expect(h.get("polygon").attributes("points")).toContain("24,12");
  });
});

describe("FlowLink 可及性", () => {
  it("整個 svg aria-hidden（流向由 stage 標題順序傳達）、不可聚焦", () => {
    const svg = mountLink({ width: 5, speed: "fast" }).get("svg");
    expect(svg.attributes("aria-hidden")).toBe("true");
    expect(svg.attributes("focusable")).toBe("false");
  });
});

describe("FlowLink reduced-motion（FR-014：只變粗細、不流動）", () => {
  function point(machineId: string, throughput: number): TelemetryPoint {
    return {
      type: "machine/data",
      machineId,
      timestamp: new Date().toISOString(),
      telemetry: { temperature: 60, vibration: 0.5, throughput, errorRate: 0.01 },
      state: "healthy",
    };
  }

  /** matchMedia 假物件：只有 `prefers-reduced-motion: reduce` 成立。 */
  function stubReducedMotion(): void {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    // 不量容器寬：版面退回 viewport 判斷（假 matchMedia 下非窄螢幕 → 並排）
    vi.stubGlobal("ResizeObserver", undefined);
  }

  it("偏好減少動態時，StageTopology 的兩段連線在高 throughput 下仍為 none，粗細照常隨 throughput", () => {
    stubReducedMotion();
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useMonitoringStore();
    store.applyTelemetryBatch(
      ["mixer-01", "press-02", "oven-04", "pack-03", "sorter-05"].map((id) => point(id, 130)),
    );
    const w = mount(StageTopology, { global: { plugins: [pinia] } });
    const links = w.findAll('[data-fg="flow-link"]');
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.attributes("data-speed")).toBe("none");
      expect(link.attributes("data-orientation")).toBe("horizontal");
      expect(link.findAll("line")[0]!.attributes("stroke-width")).toBe("8");
      expect(link.find(".animate-flow").exists()).toBe(false);
    }
    w.unmount();
  });

  it("CSS 第二道防線：tailwind.css 的 reduced-motion 區塊停掉 .animate-flow", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "../../../styles/tailwind.css"), "utf8");
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/\.animate-flow[\s\S]*?\{\s*animation: none;/);
  });
});
