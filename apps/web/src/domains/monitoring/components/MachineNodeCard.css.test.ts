/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Root } from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig";
import { beforeAll, describe, expect, it } from "vitest";
import type { MachineState } from "@flow-gatekeeper/contracts";
import {
  CARD_PLACEHOLDER_CLASS,
  CARD_ROOT_CLASS,
  CARD_STALE_CLASS,
  CARD_STATE_CLASS,
} from "../lib/card-style.js";
import { STATE_STYLE } from "../../../shared/lib/state-style.js";

/**
 * WEB-1 回歸：選取態在五種卡片狀態上都必須看得出來。
 *
 * 環境沒有瀏覽器（不裝 Playwright），所以這裡直接用專案的 tailwind config + `tailwind.css`
 * 編出與 build 相同的 CSS，再用一個只懂「單一複合選擇器」的迷你 cascade 求出每種
 * class 組合最終生效的 border-color／background-color／outline：比較 (特異性, 輸出順序)，
 * 與瀏覽器對同一元素的判定一致。
 *
 * 013 起已加入 `playwright-core` 與 `scripts/screenshots.cjs` 負責截圖與 layout shift 驗收；本測試保留為
 * 單元層的 cascade 回歸（不起瀏覽器、CI 可跑），見指南 §15.6「013 UI 全面改版」。迷你 cascade 的限制：
 * - 只看頂層規則：`@media`（含 `md:`、`[@media(hover:none)]:`、reduced-motion）內的規則一律忽略；
 * - 不處理 `!important`、組合子、`:not()`／`:is()` 與偽元素；
 * - 偽類只模擬呼叫端指定的 active 集合（hover／focus／focus-visible；鍵盤聚焦時 focus 與 focus-visible 同時成立）；
 * - 不展開 shorthand：`outline` 與 `outline-width` 等 longhand 各自求值——所以卡片的 outline 規則一律寫 shorthand
 *   （`focus:outline-none`、選取規則、焦點環規則皆然），並以測試擋下卡片上出現 outline longhand utility。
 * 卡片的選取／狀態／焦點環規則都落在上述可模擬的範圍內。
 *
 * 缺陷來源（三層）：`colors.inset` 讓 `ring-inset` 變成環顏色；狀態 class 輸出在選取 class 之後
 * 蓋掉選取；當時的 critical pulse 動畫（box-shadow 擴散）蓋掉 ring 選取框。焦點環同理（T056）：
 * 改為 `.machine-card:focus-visible` 的 outline。T065 起 pulse 改為只動 background-color 與 border-color（不用光暈），
 * 選取規則以 `animation: none` 停住它。
 *
 * T073 第四輪：選取不再換邊框與底色——只加外側 2px accent outline（offset 0），狀態自己的邊框與底色保留
 * （crit 卡選取後仍是 crit 邊框＋crit-bg 靜止底）；只有 healthy／placeholder 另鋪 accent-wash 底。
 * 焦點環（offset 2px）與選取框（offset 0）位置錯開；兩者同時成立時改畫 6px double（內線＝選取框位置、外線＝焦點環）。
 * 「選取與未選取看得出差別」現在靠 outline：未選取卡片的 outline 是 transparent（focus 時）或不存在，選取恆為 accent 2px。
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../../../..");
const configPath = join(webRoot, "tailwind.config.ts");

let root: Root;
let config: ReturnType<typeof loadConfig>;

beforeAll(async () => {
  config = loadConfig(configPath);
  // 以設定檔「路徑」建 plugin，掃描真實的 content 設定（WEB-15 排除測試檔、TQ-23 `content.relative`）：
  // 傳路徑時 tailwind 才知道設定檔位置，`relative: true` 的 glob 以它為基準、不依 vitest 的 cwd。
  // 本測試因此與正式 build 編出同一份 CSS；設定若退回掃描測試檔，下方「不含只在測試出現的 class」會轉紅。
  const plugin = tailwindcss(configPath);
  const cssPath = join(webRoot, "src/styles/tailwind.css");
  const result = await postcss([plugin]).process(readFileSync(cssPath, "utf8"), { from: cssPath });
  root = result.root;
}, 60_000);

// ---------- 迷你選擇器比對 ----------

interface Compound {
  classes: string[];
  attrs: { name: string; value: string | null }[];
  pseudos: string[];
}

/** 解析單一複合選擇器（含 Tailwind 的 `\:` 等跳脫）；含組合子、型別／萬用選擇器或偽元素時回 null。 */
function parseCompound(selector: string): Compound | null {
  const out: Compound = { classes: [], attrs: [], pseudos: [] };
  let i = 0;
  const s = selector.trim();
  const readIdent = (): string => {
    let name = "";
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "\\") {
        name += s[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (/[.:[\]#\s>+~,()]/.test(ch)) break;
      name += ch;
      i++;
    }
    return name;
  };
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === ".") {
      i++;
      out.classes.push(readIdent());
    } else if (ch === "[") {
      const close = s.indexOf("]", i);
      if (close < 0) return null;
      const body = s.slice(i + 1, close);
      const m = /^([\w-]+)(?:=(['"]?)(.*)\2)?$/.exec(body);
      if (!m) return null;
      out.attrs.push({ name: m[1]!, value: m[3] ?? null });
      i = close + 1;
    } else if (ch === ":") {
      if (s[i + 1] === ":") return null; // 偽元素
      i++;
      const name = readIdent();
      if (s[i] === "(") return null; // :not()/:is() 之類，卡片規則用不到
      out.pseudos.push(name);
    } else {
      return null; // 組合子、型別或萬用選擇器
    }
  }
  return out.classes.length > 0 || out.attrs.length > 0 ? out : null;
}

interface ElementModel {
  classes: Set<string>;
  attrs: Record<string, string>;
  active: Set<string>; // 目前成立的偽類，例如 hover
}

function matches(c: Compound, el: ElementModel): boolean {
  return (
    c.classes.every((cls) => el.classes.has(cls)) &&
    c.attrs.every((a) => a.name in el.attrs && (a.value === null || el.attrs[a.name] === a.value)) &&
    c.pseudos.every((p) => el.active.has(p))
  );
}

/** 求某屬性最終生效值（只看頂層規則；同特異性時後出現者勝）。 */
function resolveProp(el: ElementModel, prop: string): string | undefined {
  let best: { spec: number; order: number; value: string } | undefined;
  let order = 0;
  root.each((node) => {
    if (node.type !== "rule") return;
    order++;
    for (const sel of node.selectors) {
      const c = parseCompound(sel);
      if (!c || !matches(c, el)) continue;
      const spec = c.classes.length + c.attrs.length + c.pseudos.length;
      node.walkDecls(prop, (d) => {
        if (!best || spec > best.spec || (spec === best.spec && order >= best.order)) {
          best = { spec, order, value: d.value };
        }
      });
    }
  });
  return best?.value;
}

// ---------- 顏色比較 ----------

/**
 * 013 起色票全部是 `rgb(var(--c-…) / <alpha-value>)`，實際色值在 theme.css、隨主題切換；
 * 所以這裡比的是「指向哪個語意變數」，而不是 RGB 數值——兩個 class 指向同一個 `--c-*`
 * 就是同一個顏色（兩套主題皆然）。
 */
function colorVar(value: string | undefined): string | null {
  if (!value) return null;
  return /var\((--c-[\w-]+)\)/.exec(value)?.[1] ?? null;
}

function token(path: string): string {
  let cur: unknown = config.theme?.extend?.colors;
  for (const key of path.split(".")) {
    cur = typeof cur === "object" && cur !== null ? (cur as Record<string, unknown>)[key] : undefined;
  }
  if (typeof cur === "object" && cur !== null) cur = (cur as Record<string, unknown>)["DEFAULT"];
  const name = typeof cur === "string" ? colorVar(cur) : null;
  if (!name) throw new Error(`找不到色票 ${path}`);
  return name;
}

/**
 * 底色比較要連透明度一起比：卡片靜止是半透明（`bg-surface/72`、`bg-crit-bg/80`），hover 轉為不透明；
 * 只比變數名的話，刪掉 `hover:bg-crit-bg` 測試仍會過（靜止與 hover 同為 `--c-crit-bg`）。
 * Tailwind 對不透明 utility 輸出 `/ var(--tw-bg-opacity)`（該 utility 同時設為 1），`theme()` 輸出 `/ 1`，皆視為 1。
 * 回傳形如 `--c-crit-bg / 0.8`。
 */
function colorWithAlpha(value: string | undefined): string | null {
  const name = colorVar(value);
  if (!name || !value) return null;
  const raw = /\/\s*([\d.]+|var\(--tw-[\w-]+\))\s*\)/.exec(value)?.[1];
  const alpha = raw === undefined || raw.startsWith("var(") ? 1 : Number(raw);
  return `${name} / ${alpha}`;
}

/** 預期底色：`"crit.bg/0.8"` → `--c-crit-bg / 0.8`；未寫透明度視為不透明。 */
function tokenWithAlpha(spec: string): string {
  const [path, alpha] = spec.split("/");
  return `${token(path!)} / ${alpha === undefined ? 1 : Number(alpha)}`;
}

// ---------- 情境 ----------

type CardState = MachineState | "placeholder";
const STATES: readonly CardState[] = ["placeholder", ...(Object.keys(STATE_STYLE) as MachineState[])];

/**
 * 狀態 class 預期的未選取底色／邊框（`card-style.ts`）：
 * - 靜止：healthy／placeholder 為玻璃 `bg-surface/72` + `border-edge`；warning 為 1px `border-warn` 全邊框（FR-030）；
 *   critical 為半透明 `crit-bg` + `border-crit`。
 * - hover：玻璃轉為不透明（`surface-strong`；critical 為不透明 `crit-bg`）；只有 healthy／placeholder 換蝕刻邊框，
 *   warning／critical 保留狀態邊框（狀態不因 hover 消失）。
 * - stale：只把邊框改虛線（`border-style`），顏色規則與非 stale 完全相同——不與狀態邊框色競爭輸出順序。
 * 邊框比 `--c-*` 變數名；底色連透明度一起比（`surface/0.72`、`crit.bg/0.8` 對不透明的 hover 底，見 `colorWithAlpha`）。
 */
const EXPECTED_IDLE: Record<CardState, { border: string; bg: string }> = {
  placeholder: { border: "edge", bg: "surface/0.72" },
  healthy: { border: "edge", bg: "surface/0.72" },
  warning: { border: "warn", bg: "surface/0.72" },
  critical: { border: "crit", bg: "crit.bg/0.8" },
};

const EXPECTED_HOVER: Record<CardState, { border: string | null; bg: string }> = {
  placeholder: { border: "etch", bg: "surface.strong" },
  healthy: { border: "etch", bg: "surface.strong" },
  warning: { border: null, bg: "surface.strong" }, // null：沿用靜止的狀態邊框
  critical: { border: null, bg: "crit.bg" },
};

function expectedUnselected(state: CardState, hover: boolean): { border: string; bg: string } {
  const idle = EXPECTED_IDLE[state];
  if (!hover) return idle;
  return { border: EXPECTED_HOVER[state].border ?? idle.border, bg: EXPECTED_HOVER[state].bg };
}

/**
 * 選取後的預期邊框與底色（T073 第四輪）：邊框一律沿用狀態自己的（含 hover 換色）；
 * 底色 healthy／placeholder 換 accent-wash（不論 hover），warning／critical 沿用狀態底色（crit 卡仍是 crit-bg）。
 */
const SELECTED_WASH: ReadonlySet<CardState> = new Set<CardState>(["placeholder", "healthy"]);

function expectedSelected(state: CardState, hover: boolean): { border: string; bg: string } {
  const base = expectedUnselected(state, hover);
  return SELECTED_WASH.has(state) ? { border: base.border, bg: "accent.wash" } : base;
}

/** `focus+focus-visible`＝鍵盤聚焦（Tab／方向鍵／搜尋 Enter 移焦）；只有 `focus`＝滑鼠點選。 */
type Interaction =
  | "none"
  | "hover"
  | "focus"
  | "hover+focus"
  | "focus+focus-visible"
  | "hover+focus+focus-visible";

function cardElement(state: CardState, opts: { selected: boolean; stale: boolean; interaction: Interaction }): ElementModel {
  const vue = readFileSync(join(here, "MachineNodeCard.vue"), "utf8");
  const staticClass = /class="(flex min-h-\[148px\][^"]*)"/.exec(vue)?.[1];
  if (!staticClass) throw new Error("找不到 MachineNodeCard 根按鈕的靜態 class");
  const stateCls = state === "placeholder" ? CARD_PLACEHOLDER_CLASS : CARD_STATE_CLASS[state];
  const all = [staticClass, CARD_ROOT_CLASS, stateCls, opts.stale ? CARD_STALE_CLASS : ""].join(" ");
  return {
    classes: new Set(all.split(/\s+/).filter(Boolean)),
    attrs: { "data-selected": opts.selected ? "true" : "false", "data-state": state },
    active: new Set(opts.interaction === "none" ? [] : opts.interaction.split("+")),
  };
}

// 五種狀態：placeholder／healthy／warning／critical ＋ stale（疊在任一 state 上）
const CASES = STATES.flatMap((state) => [
  { state, stale: false },
  { state, stale: true },
]);

describe("WEB-1：色票不得與 Tailwind 修飾字撞名", () => {
  it("`.ring-inset` 輸出 `--tw-ring-inset: inset`，不是顏色", () => {
    const decls: string[] = [];
    root.walkRules((r) => {
      if (r.selectors.includes(".ring-inset")) r.walkDecls((d) => void decls.push(`${d.prop}: ${d.value}`));
    });
    expect(decls).toEqual(["--tw-ring-inset: inset"]);
  });

  it("頂層色票沒有 `inset`；巢狀色票（`surface.strong` → `bg-surface-strong`）指向對應的主題變數", () => {
    const colors = config.theme?.extend?.colors ?? {};
    expect(Object.keys(colors)).not.toContain("inset");
    expect(colorVar(resolveProp({ classes: new Set(["bg-surface-strong"]), attrs: {}, active: new Set() }, "background-color"))).toBe(
      "--c-surface-strong",
    );
  });
});

describe("WEB-1：MachineNodeCard 選取態勝過狀態 class", () => {
  it("模板以 data-selected 綁定選取、根元素帶錨點 class", () => {
    const vue = readFileSync(join(here, "MachineNodeCard.vue"), "utf8");
    expect(vue).toMatch(/:data-selected="selected \? 'true' : 'false'"/);
    expect(vue).toContain("CARD_ROOT_CLASS");
    // 選取不可再用一般 utility（輸出順序會輸給狀態 class）
    expect(vue).not.toMatch(/selected \? '[^']*border-accent/);
  });

  it("tailwind content 以設定檔位置解析（TQ-23）並排除測試檔（WEB-15）", () => {
    const content: unknown = config.content;
    expect(content).toMatchObject({ relative: true });
    const files = (content as { files?: unknown }).files;
    expect(files).toContain("!./src/**/*.test.ts");
  });

  it("編出的 CSS 不含只在測試檔出現的 class（WEB-15：測試字串不得進 production CSS），正式碼的 class 照常輸出", () => {
    const selectors = new Set<string>();
    root.walkRules((rule) => {
      for (const s of rule.selectors) selectors.add(s);
    });
    // `.blur`／`.shadow` 只出現在測試檔（含本檔的註解與字串）；正式碼用的是 `bg-scrim/50`、`shadow-glass`。
    expect(selectors.has(".blur")).toBe(false);
    expect(selectors.has(".shadow")).toBe(false);
    expect(selectors.has(".bg-scrim\\/50")).toBe(true);
    expect(selectors.has(".shadow-glass")).toBe(true);
  });

  it("tailwind 未開 `future.hoverOnlyWhenSupported`（開了 `hover:` 會被包進 @media，迷你 cascade 忽略它，hover 案例失真）", () => {
    const future: unknown = config.future;
    expect(future).not.toBe("all");
    const flag =
      typeof future === "object" && future !== null
        ? (future as Record<string, unknown>)["hoverOnlyWhenSupported"]
        : undefined;
    expect(flag).not.toBe(true);
  });

  for (const { state, stale } of CASES) {
    // 點選時按鈕會取得 focus：`focus:outline-none`（outline: 2px solid transparent）與選取規則
    // 同為 (0,2,0)，選取靠輸出順序勝出——focus 路徑必須一併驗。
    for (const interaction of ["none", "hover", "focus", "hover+focus"] as const) {
      const hover = interaction.includes("hover");
      const label = `${state}${stale ? "+stale" : ""}${interaction === "none" ? "" : `+${interaction}`}`;

      it(`${label}：選取 → 外側 2px accent outline（offset 0），狀態自己的邊框保留；${SELECTED_WASH.has(state) ? "accent-wash 底" : "狀態底色保留"}`, () => {
        const el = cardElement(state, { selected: true, stale, interaction });
        const expected = expectedSelected(state, hover);
        expect(colorVar(resolveProp(el, "border-color"))).toBe(token(expected.border));
        expect(colorWithAlpha(resolveProp(el, "background-color"))).toBe(tokenWithAlpha(expected.bg));
        expect(resolveProp(el, "border-style")).toBe(stale ? "dashed" : undefined);
        const outline = resolveProp(el, "outline") ?? "";
        expect(outline).toMatch(/^2px solid\b/);
        expect(colorVar(outline)).toBe(token("accent"));
        expect(resolveProp(el, "outline-offset")).toBe("0");
        expect(resolveProp(el, "animation")).toBe("none");
        // 選取不換狀態邊框：crit／warn 卡選取後不得出現 accent 邊框或 accent-wash 底
        if (!SELECTED_WASH.has(state)) {
          expect(colorVar(resolveProp(el, "border-color"))).not.toBe(token("accent"));
          expect(colorVar(resolveProp(el, "background-color"))).not.toBe(token("accent.wash"));
        }
      });

      it(`${label}：未選取 → 狀態自身外觀（與選取可區分）`, () => {
        const el = cardElement(state, { selected: false, stale, interaction });
        const border = colorVar(resolveProp(el, "border-color"));
        const bg = colorWithAlpha(resolveProp(el, "background-color"));
        const expected = expectedUnselected(state, hover);
        // stale 只換線型：虛線在任何互動下都成立，選取規則也不改 border-style
        expect(resolveProp(el, "border-style")).toBe(stale ? "dashed" : undefined);
        expect(border).toBe(token(expected.border));
        expect(bg).toBe(tokenWithAlpha(expected.bg));
        expect(border).not.toBe(token("accent"));
        expect(colorVar(bg ?? undefined)).not.toBe(token("accent.wash"));
        // 未選取卡片不得帶 accent outline
        expect(colorVar(resolveProp(el, "outline"))).not.toBe(token("accent"));
        // focus 情境確實命中 `focus:outline-none`（證明上方選取案例的 focus 路徑有被模擬到）
        if (interaction.includes("focus")) expect(resolveProp(el, "outline")).toBe("2px solid transparent");
      });
    }
  }

  it("critical pulse 只動 background-color（不透明 crit-bg）與 border-color（crit-fg），不用 box-shadow 光暈、不動尺寸", () => {
    const decls: { selector: string; prop: string; value: string }[] = [];
    root.walkAtRules("keyframes", (at) => {
      if (at.params !== "criticalPulse") return;
      at.walkRules((r) => r.walkDecls((d) => void decls.push({ selector: r.selector, prop: d.prop, value: d.value })));
    });
    expect(decls.map((d) => d.prop).sort()).toEqual(["background-color", "border-color"]);
    // 只寫 50%：起訖沿用元素自身底色與邊框色
    expect(new Set(decls.map((d) => d.selector))).toEqual(new Set(["50%"]));
    const value = (prop: string) => decls.find((d) => d.prop === prop)?.value;
    expect(colorWithAlpha(value("background-color"))).toBe(tokenWithAlpha("crit.bg"));
    expect(colorVar(value("border-color"))).toBe(token("crit.fg"));
    // 不動寬度與任何盒模型屬性
    for (const d of decls) expect(d.prop).not.toMatch(/width|shadow|outline|transform|padding|margin/);
  });

  it("嚴重卡片帶 animate-critical-pulse；選取規則停用動畫，留在 crit 邊框＋crit-bg 80% 靜止底", () => {
    expect(cardElement("critical", { selected: false, stale: false, interaction: "none" }).classes.has("animate-critical-pulse")).toBe(
      true,
    );
    let selectedAnimation: string | undefined;
    root.walkRules((r) => {
      if (r.selectors.includes(".machine-card[data-selected='true']")) {
        r.walkDecls("animation", (d) => void (selectedAnimation = d.value));
      }
    });
    expect(selectedAnimation).toBe("none");
    // 選取規則 (0,2,0) 勝過 `.animate-critical-pulse`（(0,1,0)）
    const el = cardElement("critical", { selected: true, stale: false, interaction: "none" });
    expect(resolveProp(el, "animation")).toBe("none");
    expect(colorVar(resolveProp(el, "border-color"))).toBe(token("crit"));
    expect(colorWithAlpha(resolveProp(el, "background-color"))).toBe(tokenWithAlpha("crit.bg/0.8"));
    expect(resolveProp(cardElement("critical", { selected: false, stale: false, interaction: "none" }), "animation")).toMatch(
      /^criticalPulse 1\.2s ease-in-out infinite$/,
    );
  });
});

describe("T056：卡片鍵盤焦點環（FR-034d）不被 critical pulse 蓋掉、與選取框排定優先順序", () => {
  const staticClass = (): string[] => {
    const vue = readFileSync(join(here, "MachineNodeCard.vue"), "utf8");
    const cls = /class="(flex min-h-\[148px\][^"]*)"/.exec(vue)?.[1];
    if (!cls) throw new Error("找不到 MachineNodeCard 根按鈕的靜態 class");
    return cls.split(/\s+/).filter(Boolean);
  };

  it("卡片主按鈕不用 ring 畫焦點環（一律走 outline 規則），也不帶 outline longhand utility", () => {
    const classes = staticClass();
    expect(classes.filter((c) => /(^|:)ring(-|$)/.test(c))).toEqual([]);
    // 只允許 shorthand 的 `focus:outline-none`；longhand（outline-2、outline-focus…）會與 shorthand 規則交錯、迷你 cascade 也算不準
    expect(classes.filter((c) => /(^|:)outline(-|$)/.test(c))).toEqual(["focus:outline-none"]);
  });

  it("焦點環規則存在且輸出在選取規則之後（同為 (0,2,0)，靠順序勝出）；選取＋聚焦另有 (0,3,0) 規則", () => {
    let selectedAt = -1;
    let focusAt = -1;
    let bothAt = -1;
    let order = 0;
    root.each((node) => {
      if (node.type !== "rule") return;
      order++;
      if (node.selectors.includes(".machine-card[data-selected='true']")) selectedAt = order;
      if (node.selectors.includes(".machine-card:focus-visible")) focusAt = order;
      if (node.selectors.includes(".machine-card[data-selected='true']:focus-visible")) bothAt = order;
    });
    expect(selectedAt).toBeGreaterThan(0);
    expect(focusAt).toBeGreaterThan(selectedAt);
    expect(bothAt).toBeGreaterThan(0);
  });

  it("選取框與焦點環位置錯開：選取 offset 0（緊貼卡片）、焦點環 offset 2px；雙線的內線落在選取框位置", () => {
    const sel = cardElement("healthy", { selected: true, stale: false, interaction: "none" });
    const foc = cardElement("healthy", { selected: false, stale: false, interaction: "focus+focus-visible" });
    const both = cardElement("healthy", { selected: true, stale: false, interaction: "focus+focus-visible" });
    expect(resolveProp(sel, "outline-offset")).toBe("0");
    expect(resolveProp(foc, "outline-offset")).toBe("2px");
    // double 6px = 2px 線／2px 縫／2px 線；offset 與選取框相同，內線（0–2px）與選取框重合，外線在 4–6px
    expect(resolveProp(both, "outline")).toMatch(/^6px double\b/);
    expect(resolveProp(both, "outline-offset")).toBe(resolveProp(sel, "outline-offset"));
  });

  for (const { state, stale } of CASES) {
    for (const interaction of ["focus+focus-visible", "hover+focus+focus-visible"] as const) {
      const hover = interaction.startsWith("hover");
      const label = `${state}${stale ? "+stale" : ""}+${interaction}`;

      it(`${label}：未選取 → 2px focus 色外框 outline，狀態外觀不變`, () => {
        const el = cardElement(state, { selected: false, stale, interaction });
        if (state === "critical") expect(el.classes.has("animate-critical-pulse")).toBe(true);
        const outline = resolveProp(el, "outline") ?? "";
        expect(outline).toMatch(/\b2px solid\b/);
        expect(colorVar(outline)).toBe(token("focus"));
        expect(resolveProp(el, "outline-offset")).toBe("2px");
        const expected = expectedUnselected(state, hover);
        expect(colorVar(resolveProp(el, "border-color"))).toBe(token(expected.border));
        expect(colorWithAlpha(resolveProp(el, "background-color"))).toBe(tokenWithAlpha(expected.bg));
      });

      it(`${label}：選取 → 焦點環勝出改畫 6px focus 色雙線（offset 0），狀態邊框與選取底色仍在、脈動仍停`, () => {
        const el = cardElement(state, { selected: true, stale, interaction });
        const outline = resolveProp(el, "outline") ?? "";
        expect(outline).toMatch(/^6px double\b/);
        expect(colorVar(outline)).toBe(token("focus"));
        expect(resolveProp(el, "outline-offset")).toBe("0");
        const expected = expectedSelected(state, hover);
        expect(colorVar(resolveProp(el, "border-color"))).toBe(token(expected.border));
        expect(colorWithAlpha(resolveProp(el, "background-color"))).toBe(tokenWithAlpha(expected.bg));
        expect(resolveProp(el, "animation")).toBe("none");
      });
    }
  }
});
