// flow-gatekeeper 監控台截圖劇本（feature 013，research R11；雛形 T002，後續由 T063／T070 擴充）。
//
// 用法（於 repo 根目錄；需先起 api 與 web dev server）：
//   node apps/web/scripts/screenshots.cjs --viewports [--url <url>] [--out <dir>] [--settle <ms>]
//   node apps/web/scripts/screenshots.cjs --readme        # 佔位：尚未實作（T070），exit 2
//
// --viewports：五個驗收 viewport × 兩主題（light／dark）× Copilot 面板展開，共 10 張，
//   輸出 `{viewport}-{theme}.png`，並把每張 `.machine-card` 的 getBoundingClientRect() 寫成同名 `.json`
//   （供 SC-004 layout shift 比對，quickstart 場景 3）。
//
// 瀏覽器：只用 playwright-core（不下載瀏覽器）。已以 chromium_headless_shell-1243（Chrome 153）實測；
//   playwright-core 1.64.1 內建對應的 Chromium revision 為 1248。路徑優先序：
//   1. 環境變數 PLAYWRIGHT_CHROMIUM（可執行檔絕對路徑）
//   2. PLAYWRIGHT_BROWSERS_PATH 或預設 ms-playwright 目錄下最新的 chromium_headless_shell-* ／ chromium-*
//   找不到時印出安裝指引並以非 0 結束。
//
// 截圖鉤子（contracts/ui-contract.md §3）於後續 phase 才加入；本雛形「鉤子存在就用、不存在就退回」：
//   主題：[data-fg="theme-toggle"] → 否則直接寫 document.documentElement.dataset.theme
//   選台：.machine-card[data-machine] → 否則點第二張 .machine-card
//   面板：[data-fg="copilot"][data-open] → 否則找「展開 … Copilot 面板」按鈕

// Node globals 由 root eslint.config.js 的 apps/*/scripts/**/*.cjs 區段提供；
// document 只出現在 page.evaluate（瀏覽器端）回呼內。
/* global document */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844, mobile: true },
];
const THEMES = ["light", "dark"];
const DEFAULT_URL = "http://localhost:5173/";
const DEFAULT_OUT = path.resolve(__dirname, "..", ".screenshots");
const DEFAULT_SETTLE_MS = 4000;

const INSTALL_HINT =
  "找不到可用的 Chromium。請執行 `pnpm --filter web exec playwright-core install chromium-headless-shell`，" +
  "或設定環境變數 PLAYWRIGHT_CHROMIUM 指向 chrome／chrome-headless-shell 可執行檔。";

class UserError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`[screenshots] ${msg}`);

function printUsage() {
  console.log(
    [
      "用法：node apps/web/scripts/screenshots.cjs <模式> [選項]",
      "",
      "模式：",
      "  --viewports        五 viewport × 兩主題 × Copilot 面板展開，共 10 張（含卡片 rect JSON）",
      "  --readme           README 功能截圖（尚未實作，見 T070）",
      "",
      "選項：",
      `  --url <url>        dev server 位址（預設 ${DEFAULT_URL}）`,
      `  --out <dir>        輸出目錄（預設 apps/web/.screenshots）`,
      `  --settle <ms>      載入後等待遙測到齊的毫秒數（預設 ${DEFAULT_SETTLE_MS}）`,
      "",
      "環境變數：PLAYWRIGHT_CHROMIUM＝Chromium 可執行檔路徑（未設定時自動尋找 ms-playwright 目錄）",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const opts = { mode: null, url: DEFAULT_URL, out: DEFAULT_OUT, settle: DEFAULT_SETTLE_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UserError(`${arg} 需要一個值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--viewports":
      case "--readme":
        if (opts.mode && opts.mode !== arg) throw new UserError("--viewports 與 --readme 只能擇一");
        opts.mode = arg;
        break;
      case "--url":
        opts.url = next();
        break;
      case "--out":
        opts.out = path.resolve(next());
        break;
      case "--settle": {
        const ms = Number(next());
        if (!Number.isInteger(ms) || ms < 0) throw new UserError("--settle 必須是非負整數（毫秒）");
        opts.settle = ms;
        break;
      }
      case "-h":
      case "--help":
        opts.mode = "--help";
        break;
      default:
        throw new UserError(`未知參數：${arg}`);
    }
  }
  return opts;
}

// ---------- 瀏覽器尋找 ----------

function msPlaywrightDirs() {
  const dirs = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0") {
    dirs.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
  const home = os.homedir();
  if (process.platform === "win32") {
    dirs.push(path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright"));
  } else if (process.platform === "darwin") {
    dirs.push(path.join(home, "Library", "Caches", "ms-playwright"));
  } else {
    dirs.push(path.join(home, ".cache", "ms-playwright"));
  }
  return [...new Set(dirs)];
}

// 各發行目錄內可執行檔的相對路徑（依平台）。
const EXECUTABLES = {
  headless: [
    "chrome-headless-shell-win64/chrome-headless-shell.exe",
    "chrome-headless-shell-linux64/chrome-headless-shell",
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
  ],
  full: [
    "chrome-win64/chrome.exe",
    "chrome-win/chrome.exe",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  ],
};

function findChromium() {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM;
  if (fromEnv) {
    if (fs.existsSync(fromEnv)) return fromEnv;
    throw new UserError(`PLAYWRIGHT_CHROMIUM 指向的檔案不存在：${fromEnv}\n${INSTALL_HINT}`);
  }

  const candidates = [];
  for (const root of msPlaywrightDirs()) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = /^(chromium_headless_shell|chromium)-(\d+)$/.exec(entry.name);
      if (!match) continue;
      const kind = match[1] === "chromium_headless_shell" ? "headless" : "full";
      candidates.push({ dir: path.join(root, entry.name), kind, revision: Number(match[2]) });
    }
  }
  // 最新 revision 優先；同 revision 時 headless shell 優先（較輕、與 headless 截圖相符）。
  candidates.sort((a, b) => b.revision - a.revision || (a.kind === "headless" ? -1 : 1));

  for (const candidate of candidates) {
    for (const rel of EXECUTABLES[candidate.kind]) {
      const exe = path.join(candidate.dir, rel);
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new UserError(INSTALL_HINT);
}

// ---------- dev server 檢查 ----------

function checkServer(url) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new UserError(`--url 不是合法網址：${url}`));
      return;
    }
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.get(parsed, (res) => {
      res.resume();
      const code = res.statusCode ?? 0;
      if (code >= 400) reject(new UserError(`dev server 回應 ${code}：${url}`));
      else resolve(code);
    });
    req.setTimeout(5000, () => req.destroy(new Error("連線逾時")));
    req.on("error", (err) =>
      reject(
        new UserError(
          `dev server 未啟動：無法連線 ${url}（${err.code || err.message}）。\n` +
            "請先 `docker compose up -d`、`pnpm --filter api start:dev`、`pnpm --filter web dev`，或以 --url 指定位址。",
        ),
      ),
    );
  });
}

// ---------- 頁面操作（鉤子存在就用、不存在就退回） ----------

// 布林型 data-* 鉤子：契約以「屬性存在」表示開啟，但 1.1.0 卡片渲染成 "true"／"false" 字串，兩者都要認得。
const isFlagOn = (value) => value !== null && value !== "false";

async function waitForCards(page) {
  try {
    await page.locator(".machine-card").first().waitFor({ state: "visible", timeout: 15000 });
  } catch {
    throw new UserError("頁面載入後 15 秒內沒有出現 .machine-card——api／遙測是否已啟動？");
  }
}

async function selectMachine(page) {
  const hooked = page.locator(".machine-card[data-machine]");
  const cards = (await hooked.count()) > 0 ? hooked : page.locator(".machine-card");
  const count = await cards.count();
  const target = cards.nth(count > 1 ? 1 : 0);
  // 已選取（data-selected）就不再點，避免切換成取消選取。
  if (!isFlagOn(await target.getAttribute("data-selected"))) {
    // 點左上角內距處，避開卡片內的診斷按鈕等子元素。
    await target.click({ position: { x: 12, y: 12 } });
  }
  await sleep(500);
}

async function ensureCopilotOpen(page, name) {
  const panel = page.locator('[data-fg="copilot"]').first();
  // 只取看得見的那顆：手機寬度下桌機的展開窄條仍在 DOM 裡但隱藏，不加 :visible 會永遠點不到 peek 條。
  const expand = page
    .locator(
      'button[aria-label*="展開"][aria-label*="Copilot"]:visible, button[aria-label*="展開"][aria-label*="診斷"]:visible',
    )
    .first();
  const collapse = page
    .locator(
      'button[aria-label*="收合"][aria-label*="Copilot"]:visible, button[aria-label*="收合"][aria-label*="診斷"]:visible',
    )
    .first();
  const visible = async (loc) => (await loc.count()) > 0 && (await loc.isVisible());
  // true＝已展開；false＝確定收合；null＝無法判定。
  const isOpen = async () => {
    if ((await panel.count()) > 0) return isFlagOn(await panel.getAttribute("data-open"));
    if (await visible(expand)) return false;
    if (await visible(collapse)) return true;
    return null;
  };

  let open = await isOpen();
  if (open !== true && (await visible(expand))) {
    await expand.click();
    await sleep(400);
    open = await isOpen();
  }
  if (open !== true) {
    log(`${name} 警告：無法確認 Copilot 面板已展開（[data-fg="copilot"][data-open] 與展開按鈕皆無法確認），截圖可能不是面板展開狀態`);
  }
}

async function applyTheme(page, theme) {
  const current = () => page.evaluate(() => document.documentElement.dataset.theme || "light");
  // ThemeToggle 是兩段式按鈕群：點「未按下」的那一段才會切換；容器中心點會落在目前主題上、等於沒切。
  // 手機寬度下 rail 隱藏（主題切換移入工具列是 T060），看不見時不點、直接退回寫 dataset。
  if ((await current()) !== theme) {
    const target = page.locator('[data-fg="theme-toggle"] button[aria-pressed="false"]:visible');
    if ((await target.count()) > 0) {
      // 用 dispatchEvent 而非 click()：768–1023 寬度下 sheet 展開時，rail 上的切換鈕被遮罩（z-40）蓋住，
      // click() 會等不到可點狀態而逾時；force click 則會點到遮罩、把 sheet 收合。
      await target.first().dispatchEvent("click");
      await sleep(300);
    }
  }
  if ((await current()) !== theme) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
  }
  await sleep(300); // 讓主題轉場落定
}

async function collectCardRects(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".machine-card"));
    return {
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      },
      cards: cards.map((el, index) => {
        const r = el.getBoundingClientRect();
        return {
          index,
          machine: el.getAttribute("data-machine"),
          selected: el.hasAttribute("data-selected") && el.getAttribute("data-selected") !== "false",
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          left: r.left,
        };
      }),
    };
  });
}

// ---------- 模式 ----------

async function runViewports(opts) {
  const executablePath = findChromium();
  await checkServer(opts.url);

  const { chromium } = require("playwright-core");
  fs.mkdirSync(opts.out, { recursive: true });
  log(`瀏覽器：${executablePath}`);
  log(`目標：${opts.url} → 輸出：${opts.out}`);

  const browser = await chromium.launch({ executablePath, headless: true });
  let written = 0;
  try {
    for (const vp of VIEWPORTS) {
      const name = `${vp.width}x${vp.height}`;
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        isMobile: Boolean(vp.mobile),
        hasTouch: Boolean(vp.mobile),
      });
      try {
        const page = await context.newPage();
        page.on("console", (m) => {
          if (m.type() === "error") log(`${name} console.error：${m.text().slice(0, 200)}`);
        });
        await page.goto(opts.url, { waitUntil: "networkidle" });
        await waitForCards(page);
        await sleep(opts.settle); // 等遙測到齊
        await selectMachine(page);
        await ensureCopilotOpen(page, name);

        for (const theme of THEMES) {
          await applyTheme(page, theme);
          const base = path.join(opts.out, `${name}-${theme}`);
          await page.screenshot({ path: `${base}.png`, fullPage: false });
          const rects = await collectCardRects(page);
          const actualTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
          if (actualTheme !== theme) {
            log(`${name} 警告：要求主題 ${theme}，實際 documentElement.dataset.theme 為 ${actualTheme}`);
          }
          const payload = {
            viewport: { width: vp.width, height: vp.height },
            theme,
            actualTheme,
            url: opts.url,
            capturedAt: new Date().toISOString(),
            ...rects,
          };
          fs.writeFileSync(`${base}.json`, `${JSON.stringify(payload, null, 2)}\n`);
          written += 1;
          log(`寫入 ${path.basename(base)}.png／.json（${rects.cards.length} 張卡片）`);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  log(`完成：${written} 張截圖`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  switch (opts.mode) {
    case "--viewports":
      await runViewports(opts);
      return;
    case "--readme":
      log("--readme 尚未實作，見 T070");
      process.exitCode = 2;
      return;
    case "--help":
      printUsage();
      return;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof UserError) {
    console.error(`[screenshots] 錯誤：${err.message}`);
  } else {
    console.error(`[screenshots] 執行失敗：${err && err.message ? err.message.split("\n")[0] : String(err)}`);
    if (process.env.DEBUG) console.error(err);
  }
  process.exit(1);
});
