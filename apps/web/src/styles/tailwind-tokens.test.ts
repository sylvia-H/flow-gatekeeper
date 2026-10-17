/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import loadConfig from "tailwindcss/loadConfig";
import { describe, expect, it } from "vitest";

/**
 * 013 主題 token 的回歸測試：
 * - Tailwind 對刻度外的 opacity 修飾是靜默略過，`bg-surface/72`（磨砂玻璃）必須真的產生規則；
 * - theme.css 兩套主題定義同一組變數，且選取／主要動作的色與玻璃底色可區分。
 */
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");

async function compileUtilities(classes: string): Promise<string> {
  const config = loadConfig(join(webRoot, "tailwind.config.ts"));
  const result = await postcss([
    tailwindcss({ ...config, content: [{ raw: `<div class="${classes}"></div>`, extension: "html" }] }),
  ]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

type ThemeVars = Record<string, string>;

/** 解析 theme.css 中 `:root[data-theme='<name>'] { --c-x: R G B; … }` 區塊。 */
function themeVars(name: "light" | "dark"): ThemeVars {
  const css = readFileSync(join(here, "theme.css"), "utf8");
  const start = css.indexOf(`:root[data-theme='${name}']`);
  const open = start < 0 ? -1 : css.indexOf("{", start);
  const block = open < 0 ? undefined : css.slice(open + 1, css.indexOf("}", open));
  if (!block) throw new Error(`theme.css 找不到 ${name} 主題區塊`);
  const vars: ThemeVars = {};
  for (const m of block.matchAll(/(--c-[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim();
  return vars;
}

describe("Tailwind token：磨砂玻璃 alpha", () => {
  it("`bg-surface/72` 產生 rgb(var(--c-surface) / 0.72)", async () => {
    const css = await compileUtilities("bg-surface/72");
    // 編譯後選擇器是 `.bg-surface\/72`（斜線被跳脫）
    const rule = /\.bg-surface\\\/72\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule, "編譯結果沒有 .bg-surface\\/72 規則").toBeDefined();
    expect(rule).toMatch(/background-color:\s*rgb\(var\(--c-surface\) \/ 0\.72\)/);
  }, 60_000);
});

describe("theme.css 兩套主題", () => {
  const light = themeVars("light");
  const dark = themeVars("dark");

  it("兩套主題定義同一組變數，且皆為 R G B 三元組", () => {
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
    for (const value of [...Object.values(light), ...Object.values(dark)]) {
      expect(value).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)("%s：accent-wash 與 accent 皆不等於 surface（選取與未選取可區分）", (_name, vars) => {
    expect(vars["--c-surface"]).toBeDefined();
    expect(vars["--c-accent-wash"]).not.toBe(vars["--c-surface"]);
    expect(vars["--c-accent"]).not.toBe(vars["--c-surface"]);
  });
});
