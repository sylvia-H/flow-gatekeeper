/// <reference types="node" />
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectScope, nextTick, reactive, type EffectScope } from "vue";
import {
  APP_TITLE,
  FAVICON_TOKENS,
  documentAlertOf,
  faviconDataUrl,
  faviconSvg,
  readFaviconColors,
  useDocumentAlert,
  type DocumentAlertInput,
  type FaviconColors,
} from "./useDocumentAlert.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = (): HTMLElement => document.documentElement;
const iconLink = (): HTMLLinkElement | null => document.querySelector<HTMLLinkElement>('link[rel~="icon"]');

/** 測試用 token（`R G B` 三元組，與 theme.css 同格式）；happy-dom 不載入 theme.css，改以 inline 自訂屬性模擬。 */
const LIGHT: Record<(typeof FAVICON_TOKENS)[number], string> = {
  surface: "255 255 255",
  ink: "31 42 51",
  "ink-3": "74 87 99",
  accent: "15 110 140",
  crit: "198 40 40",
  stale: "122 135 146",
};
const DARK: typeof LIGHT = {
  surface: "39 50 60",
  ink: "227 233 238",
  "ink-3": "154 167 178",
  accent: "79 179 209",
  crit: "240 96 95",
  stale: "125 138 149",
};

function setTokens(tokens: typeof LIGHT | null): void {
  for (const name of FAVICON_TOKENS) {
    if (tokens) root().style.setProperty(`--c-${name}`, tokens[name]);
    else root().style.removeProperty(`--c-${name}`);
  }
}

const COLORS: FaviconColors = {
  surface: "rgb(255,255,255)",
  ink: "rgb(31,42,51)",
  "ink-3": "rgb(74,87,99)",
  accent: "rgb(15,110,140)",
  crit: "rgb(198,40,40)",
  stale: "rgb(122,135,146)",
};

/** data URL 解回 SVG 原文。 */
const decode = (href: string | null | undefined): string =>
  decodeURIComponent((href ?? "").replace(/^data:image\/svg\+xml;utf8,/, ""));

/** 等 MutationObserver 回呼（microtask）與 Vue 的 pre-flush watcher。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

describe("documentAlertOf", () => {
  const base: DocumentAlertInput = { critical: 0, connection: "connected", everConnected: true };

  it("連線正常、無嚴重：產品名與基礎 favicon", () => {
    expect(documentAlertOf(base)).toEqual({ title: APP_TITLE, icon: "normal" });
  });

  it("嚴重 N > 0：「● 嚴重 N · flow-gatekeeper」與嚴重版 favicon", () => {
    expect(documentAlertOf({ ...base, critical: 1 })).toEqual({ title: "● 嚴重 1 · flow-gatekeeper", icon: "critical" });
    expect(documentAlertOf({ ...base, critical: 3 }).title).toBe("● 嚴重 3 · flow-gatekeeper");
  });

  it("重新連線中／曾連上後已斷線：離線標示蓋過嚴重（與橫幅優先序同向），文字與連線 chip 一致", () => {
    expect(documentAlertOf({ ...base, critical: 2, connection: "reconnecting" })).toEqual({
      title: "○ 重新連線中 · flow-gatekeeper",
      icon: "offline",
    });
    expect(documentAlertOf({ ...base, connection: "disconnected" })).toEqual({
      title: "○ 已斷線 · flow-gatekeeper",
      icon: "offline",
    });
  });

  it("從未連上但已在重新連線中（第一次嘗試失敗）：同樣標離線，與橫幅「重新連線中…」一致", () => {
    expect(documentAlertOf({ critical: 0, connection: "reconnecting", everConnected: false })).toEqual({
      title: "○ 重新連線中 · flow-gatekeeper",
      icon: "offline",
    });
  });

  it("第一次嘗試結果出來前（disconnected 且從未連上）不標，與橫幅的中性「連線中…」一致", () => {
    expect(documentAlertOf({ critical: 0, connection: "disconnected", everConnected: false })).toEqual({
      title: APP_TITLE,
      icon: "normal",
    });
  });
});

describe("faviconSvg／faviconDataUrl", () => {
  it("基礎版：玻璃片、刻度、液柱，沒有狀態點", () => {
    const svg = faviconSvg("normal", COLORS);
    expect(svg).toContain(`fill="${COLORS.surface}" stroke="${COLORS.ink}"`);
    expect(svg).toContain(`stroke="${COLORS["ink-3"]}"`);
    expect(svg).toContain(`fill="${COLORS.accent}"`);
    expect(svg).not.toContain("<circle");
  });

  it("嚴重版：右上實心 crit 點、surface 圈", () => {
    const svg = faviconSvg("critical", COLORS);
    expect(svg).toMatch(/<circle [^>]*fill="rgb\(198,40,40\)" stroke="rgb\(255,255,255\)"/);
    expect(svg).not.toContain(COLORS.stale);
  });

  it("離線版：右上 stale 空心圈（surface 填色）", () => {
    const svg = faviconSvg("offline", COLORS);
    expect(svg).toMatch(/<circle [^>]*fill="rgb\(255,255,255\)" stroke="rgb\(122,135,146\)" stroke-width="3"/);
    expect(svg).not.toContain(COLORS.crit);
  });

  it("data URL 以 encodeURIComponent 編碼（不留原始 #、<、\"、空白），解回即原文", () => {
    const url = faviconDataUrl("critical", COLORS);
    expect(url.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    expect(url.slice("data:image/svg+xml;utf8,".length)).not.toMatch(/[#<>" ]/);
    expect(decode(url)).toBe(faviconSvg("critical", COLORS));
  });

  it("composable 原始碼不含任何 hex 色值（色值只在 theme.css）", () => {
    const src = readFileSync(join(here, "useDocumentAlert.ts"), "utf8");
    expect(src).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe("readFaviconColors", () => {
  afterEach(() => setTokens(null));

  it("把 theme.css 的 `R G B` 三元組轉成 rgb(R,G,B)", () => {
    setTokens(LIGHT);
    expect(readFaviconColors()).toEqual(COLORS);
  });

  it("任一個 token 讀不到（例如沒載入 theme.css）回 null", () => {
    expect(readFaviconColors()).toBeNull();
    setTokens(LIGHT);
    root().style.removeProperty("--c-stale");
    expect(readFaviconColors()).toBeNull();
  });
});

describe("useDocumentAlert", () => {
  let scope: EffectScope | null = null;
  let input: DocumentAlertInput;

  function start(): void {
    scope = effectScope();
    scope.run(() => {
      useDocumentAlert(() => ({ ...input }));
    });
  }

  beforeEach(() => {
    document.title = "原始標題";
    document.head.querySelectorAll('link[rel~="icon"]').forEach((el) => el.remove());
    root().dataset.theme = "light";
    setTokens(LIGHT);
    input = reactive<DocumentAlertInput>({ critical: 0, connection: "connected", everConnected: true });
  });

  afterEach(() => {
    scope?.stop();
    scope = null;
    document.head.querySelectorAll('link[rel~="icon"]').forEach((el) => el.remove());
    setTokens(null);
  });

  it("掛上即寫入目前狀態；嚴重數變化 → 標題與 favicon 跟著換；回 0 → 還原產品名與基礎 favicon", async () => {
    start();
    expect(document.title).toBe(APP_TITLE);
    expect(decode(iconLink()?.getAttribute("href"))).toBe(faviconSvg("normal", COLORS));

    input.critical = 2;
    await nextTick();
    expect(document.title).toBe("● 嚴重 2 · flow-gatekeeper");
    expect(decode(iconLink()?.getAttribute("href"))).toBe(faviconSvg("critical", COLORS));

    input.critical = 1;
    await nextTick();
    expect(document.title).toBe("● 嚴重 1 · flow-gatekeeper");

    input.critical = 0;
    await nextTick();
    expect(document.title).toBe(APP_TITLE);
    expect(decode(iconLink()?.getAttribute("href"))).toBe(faviconSvg("normal", COLORS));
  });

  it("斷線 → 離線標題與離線 favicon；重連 → 回到依嚴重數決定", async () => {
    input.critical = 1;
    start();
    input.connection = "reconnecting";
    await nextTick();
    expect(document.title).toBe("○ 重新連線中 · flow-gatekeeper");
    expect(decode(iconLink()?.getAttribute("href"))).toBe(faviconSvg("offline", COLORS));

    input.connection = "connected";
    await nextTick();
    expect(document.title).toBe("● 嚴重 1 · flow-gatekeeper");
    expect(decode(iconLink()?.getAttribute("href"))).toBe(faviconSvg("critical", COLORS));
  });

  it("切換主題（data-theme）→ favicon 改用新主題的 token 重組；標題不變", async () => {
    input.critical = 1;
    start();
    setTokens(DARK);
    root().dataset.theme = "dark";
    await flush();
    const svg = decode(iconLink()?.getAttribute("href"));
    expect(svg).toContain('fill="rgb(240,96,95)"'); // 深色 crit
    expect(svg).toContain('stroke="rgb(227,233,238)"'); // 深色 ink 框
    expect(document.title).toBe("● 嚴重 1 · flow-gatekeeper");
  });

  it("衍生值不變時不重寫 DOM（來源每秒或每幀重算也不多寫）", async () => {
    input.critical = 1;
    start();
    // 外部改掉標題與 href：composable 若在每次來源重算時都寫，下面會被蓋回去。
    document.title = "外部改的";
    iconLink()?.setAttribute("href", "/外部.svg");

    // 連線中改 everConnected：來源與 `alert` 都會重算（新物件），但標題與 favicon 字串不變。
    input.everConnected = false;
    await nextTick();
    expect(document.title).toBe("外部改的");
    expect(iconLink()?.getAttribute("href")).toBe("/外部.svg");
  });

  it("讀不到 token（沒載入 theme.css）：不建 link、不丟例外，只改標題", async () => {
    setTokens(null);
    expect(() => start()).not.toThrow();
    expect(iconLink()).toBeNull();
    input.critical = 1;
    await nextTick();
    expect(document.title).toBe("● 嚴重 1 · flow-gatekeeper");
    expect(iconLink()).toBeNull();
  });

  it("沒有 <link rel=icon> 時自建；scope 結束時移除自建的 link、還原原始標題、停止監看主題", async () => {
    expect(iconLink()).toBeNull();
    start();
    const link = iconLink();
    expect(link?.getAttribute("type")).toBe("image/svg+xml");

    input.critical = 1;
    await nextTick();
    expect(document.title).toBe("● 嚴重 1 · flow-gatekeeper");

    scope?.stop();
    scope = null;
    expect(document.title).toBe("原始標題");
    expect(iconLink()).toBeNull();

    // 停止後切主題不應再建 link 或寫 href
    root().dataset.theme = "dark";
    await flush();
    expect(iconLink()).toBeNull();
  });

  it("既有的 link：scope 結束時還原原本的 href", () => {
    const link = document.createElement("link");
    link.rel = "icon";
    link.setAttribute("href", "/原本.svg");
    document.head.appendChild(link);

    input.critical = 1;
    start();
    expect(decode(link.getAttribute("href"))).toBe(faviconSvg("critical", COLORS));

    scope?.stop();
    scope = null;
    expect(link.getAttribute("href")).toBe("/原本.svg");
    expect(iconLink()).toBe(link);
    expect(document.title).toBe("原始標題");
  });
});
