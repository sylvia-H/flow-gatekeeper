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
 * **刻意以 CSS cascade 測試取代 Playwright 截圖**（不新增瀏覽器相依）。迷你 cascade 的限制：
 * - 只看頂層規則：`@media`（含 `md:`、`[@media(hover:none)]:`、reduced-motion）內的規則一律忽略；
 * - 不處理 `!important`、組合子、`:not()`／`:is()` 與偽元素；
 * - 偽類只模擬呼叫端指定的 active 集合（hover／focus），`:focus-visible` 不成立。
 * 卡片的選取／狀態規則都落在上述可模擬的範圍內。
 *
 * 缺陷來源（三層）：`colors.inset` 讓 `ring-inset` 變成環顏色；狀態 class 輸出在選取 class 之後
 * 蓋掉選取；critical pulse 動畫（box-shadow）蓋掉 ring 選取框。
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../../../..");
const toGlob = (p: string): string => p.replace(/\\/g, "/");

let root: Root;
let config: ReturnType<typeof loadConfig>;

beforeAll(async () => {
  config = loadConfig(join(webRoot, "tailwind.config.ts"));
  // content 改成絕對路徑，不依 vitest 的 cwd；掃描範圍與正式 build 相同（整個 src）。
  const plugin = tailwindcss({
    ...config,
    content: [toGlob(join(webRoot, "index.html")), toGlob(join(webRoot, "src/**/*.{vue,ts}"))],
  });
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

function rgbOf(value: string | undefined): [number, number, number] | null {
  if (!value) return null;
  const hex = /#([0-9a-f]{6})\b/i.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(value);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

function token(path: string): [number, number, number] {
  let cur: unknown = config.theme?.extend?.colors;
  for (const key of path.split(".")) {
    cur = typeof cur === "object" && cur !== null ? (cur as Record<string, unknown>)[key] : undefined;
  }
  if (typeof cur === "object" && cur !== null) cur = (cur as Record<string, unknown>)["DEFAULT"];
  const rgb = typeof cur === "string" ? rgbOf(cur) : null;
  if (!rgb) throw new Error(`找不到色票 ${path}`);
  return rgb;
}

// ---------- 情境 ----------

type CardState = MachineState | "placeholder";
const STATES: readonly CardState[] = ["placeholder", ...(Object.keys(STATE_STYLE) as MachineState[])];

/** 狀態 class 預期的未選取底色／邊框（design-spec §7.3）。 */
const EXPECTED_IDLE: Record<CardState, { border: string; bg: string }> = {
  placeholder: { border: "subtle", bg: "surface" },
  healthy: { border: "subtle", bg: "surface" },
  warning: { border: "subtle", bg: "surface" },
  critical: { border: "crit.border", bg: "crit.bg" },
};

type Interaction = "none" | "hover" | "focus" | "hover+focus";

function cardElement(state: CardState, opts: { selected: boolean; stale: boolean; interaction: Interaction }): ElementModel {
  const vue = readFileSync(join(here, "MachineNodeCard.vue"), "utf8");
  const staticClass = /class="(flex min-h-\[148px\][^"]*)"/.exec(vue)?.[1];
  if (!staticClass) throw new Error("找不到 MachineNodeCard 根按鈕的靜態 class");
  const stateCls = state === "placeholder" ? CARD_PLACEHOLDER_CLASS : CARD_STATE_CLASS[state];
  const all = [staticClass, CARD_ROOT_CLASS, stateCls, opts.stale ? CARD_STALE_CLASS : ""].join(" ");
  return {
    classes: new Set(all.split(/\s+/).filter(Boolean)),
    attrs: { "data-selected": opts.selected ? "true" : "false" },
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

  it("頂層色票沒有 `inset`（改為 `surface.inset` → `bg-surface-inset`）", () => {
    const colors = config.theme?.extend?.colors ?? {};
    expect(Object.keys(colors)).not.toContain("inset");
    expect(rgbOf(resolveProp({ classes: new Set(["bg-surface-inset"]), attrs: {}, active: new Set() }, "background-color"))).toEqual(
      token("surface.inset"),
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

      it(`${label}：選取 → accent 邊框、accent-wash 底、accent outline`, () => {
        const el = cardElement(state, { selected: true, stale, interaction });
        expect(rgbOf(resolveProp(el, "border-color"))).toEqual(token("accent"));
        expect(rgbOf(resolveProp(el, "background-color"))).toEqual(token("accent.wash"));
        const outline = resolveProp(el, "outline") ?? "";
        expect(outline).toMatch(/\b1px solid\b/);
        expect(rgbOf(outline)).toEqual(token("accent"));
        expect(resolveProp(el, "outline-offset")).toBe("-2px");
      });

      it(`${label}：未選取 → 狀態自身外觀（與選取可區分）`, () => {
        const el = cardElement(state, { selected: false, stale, interaction });
        const border = rgbOf(resolveProp(el, "border-color"));
        const bg = rgbOf(resolveProp(el, "background-color"));
        if (hover) {
          expect(border).toEqual(token("strong"));
          expect(bg).toEqual(token("surface.hover"));
        } else {
          expect(border).toEqual(token(EXPECTED_IDLE[state].border));
          expect(bg).toEqual(token(EXPECTED_IDLE[state].bg));
        }
        expect(border).not.toEqual(token("accent"));
        expect(bg).not.toEqual(token("accent.wash"));
        // 未選取卡片不得帶 accent outline
        expect(rgbOf(resolveProp(el, "outline"))).not.toEqual(token("accent"));
        // focus 情境確實命中 `focus:outline-none`（證明上方選取案例的 focus 路徑有被模擬到）
        if (interaction.includes("focus")) expect(resolveProp(el, "outline")).toBe("2px solid transparent");
      });
    }
  }

  it("critical pulse 動畫只動 box-shadow，不碰選取態用到的屬性", () => {
    const animated = new Set<string>();
    root.walkAtRules("keyframes", (at) => {
      if (at.params === "criticalPulse") at.walkDecls((d) => void animated.add(d.prop));
    });
    expect([...animated]).toEqual(["box-shadow"]);
    for (const prop of ["border-color", "background-color", "outline", "outline-color"]) {
      expect(animated.has(prop)).toBe(false);
    }
  });
});
