/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `public/favicon*.svg` 是 theme.css 以外唯一寫死色值的地方（靜態資產無法讀 CSS 變數）。
 * 這裡核對每個 fill／stroke 都對得上 theme.css 淺色主題的具名 token，改 token 值時本測試會提醒同步 favicon。
 */
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../../public");

/** theme.css 淺色區塊：`--c-x: R G B;` → { "#RRGGBB": "x" }。 */
function lightTokensByHex(): Map<string, string> {
  const css = readFileSync(join(here, "theme.css"), "utf8");
  const start = css.indexOf(":root[data-theme='light']");
  const open = css.indexOf("{", start);
  const block = css.slice(open + 1, css.indexOf("}", open));
  const map = new Map<string, string>();
  for (const m of block.matchAll(/--c-([\w-]+)\s*:\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
    const hex = `#${[m[2], m[3], m[4]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
    if (!map.has(hex)) map.set(hex, m[1]!);
  }
  return map;
}

const FILES: Record<string, string[]> = {
  "favicon.svg": ["surface", "ink", "ink-3", "accent"],
  "favicon-critical.svg": ["surface", "ink", "ink-3", "accent", "crit"],
  "favicon-offline.svg": ["surface", "ink", "ink-3", "accent", "stale"],
};

describe("favicon 色值對齊 theme.css 淺色 token", () => {
  const tokens = lightTokensByHex();

  for (const [file, expected] of Object.entries(FILES)) {
    it(`${file} 只用具名 token 的色值`, () => {
      const svg = readFileSync(join(publicDir, file), "utf8");
      const used = [...svg.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]!.toUpperCase());
      expect(used.length).toBeGreaterThan(0);
      const names = new Set(
        used.map((hex) => {
          const name = tokens.get(hex);
          expect(name, `${file} 的 ${hex} 不是 theme.css 淺色主題的 token 色值`).toBeDefined();
          return name!;
        }),
      );
      // surface 與 surface-strong／highlight 同為 #FFFFFF，對照表取第一個（surface）。
      expect([...names].sort()).toEqual([...expected].sort());
    });
  }
});
