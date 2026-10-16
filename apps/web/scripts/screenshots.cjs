// flow-gatekeeper 監控台截圖劇本（feature 013，research R11；雛形 T002，後續由 T063／T070 擴充）。
//
// 用法（於 repo 根目錄；需先起 api 與 web dev server）：
//   node apps/web/scripts/screenshots.cjs --viewports [--url <url>] [--out <dir>] [--settle <ms>]
//     [--search <query>] [--pulse-wait <ms>] [--no-fail] [--only <WxH,...>]
//   node apps/web/scripts/screenshots.cjs --readme        # 佔位：尚未實作（T070），exit 2
//   各選項說明見 --help。
//
// --viewports：五個驗收 viewport × 兩主題（light／dark）× Copilot 面板展開，共 10 張，
//   輸出 `{viewport}-{theme}.png`，並把每張 `.machine-card` 與 stage 欄的 getBoundingClientRect() 寫成同名 `.json`
//   （T063：SC-004 layout shift 量測，quickstart 場景 3）。每張截圖後依序量測：
//   1. overflow：無橫向捲動（scrollWidth ≤ clientWidth），卡片與 stage 欄不超出視窗左右緣。
//   2. search（FR-015）：輸入只命中一台的查詢 → 三欄仍在、欄 x／width 不變（stacked 時欄 y 仍由上而下）、
//      留下的卡片 x／width／height 不變；清除後所有卡片與欄的 rect 與過濾前一致。工具列 compact（搜尋收成
//      圖示鈕）時改走覆蓋式搜尋。找不到搜尋框、查詢沒真的過濾（命中 0 台或全部）或沒有任何一欄被清空
//      （不構成 FR-015 情境）時記 skipped。
//   3. pulse：等到出現 critical 卡片（mock 每 240 tick 一次尖峰），間隔 200ms 取 7 次 rect（涵蓋 1.2s 脈動週期）；
//      另比對基準 → critical 的 rect（狀態變化不得改尺寸），記錄實際觀察到的狀態轉換；基準已是 critical 時標
//      「未涵蓋狀態變化」。等不到 critical 記 skipped。
//   4. hover：逐張卡片捲入視野、滑鼠移開取 rect → 移到卡片中心取 rect；中心點被面板遮住的卡片
//      （768 sheet 遮罩、390 bottom-sheet）改用 CDP CSS.forcePseudoState 強制 :hover。
//   5. selected：點另一張卡片（面板已展開，不應有版面變化）取 rect，量完點回原卡片；面板收合且展開不了時記 skipped。
//   總表欄位依執行順序：overflow、search、pulse、hover、selected。
//   rect 一律在雙 requestAnimationFrame 後取（避開 transition 中途），比較 x／y／width／height，容差 0.5px；
//   x／y 為內容座標（加回祖先捲動量），捲動不算 layout shift。
//   任一項有差值 → `.json` 的 violations 列出、總表標 ✗、以 exit 1 結束（--no-fail 只報告）。
//
// 瀏覽器：只用 playwright-core（不下載瀏覽器）。已以 chromium_headless_shell-1243（Chrome 153）實測；
//   playwright-core 1.64.1 內建對應的 Chromium revision 為 1248。路徑優先序：
//   1. 環境變數 PLAYWRIGHT_CHROMIUM（可執行檔絕對路徑）
//   2. PLAYWRIGHT_BROWSERS_PATH 或預設 ms-playwright 目錄下最新的 chromium_headless_shell-* ／ chromium-*
//   找不到時印出安裝指引並以非 0 結束。
//
// 截圖鉤子（contracts/ui-contract.md §3）「存在就用、不存在就退回」：
//   主題：[data-fg="theme-toggle"] → 否則直接寫 document.documentElement.dataset.theme
//   選台：.machine-card[data-machine] → 否則點第二張 .machine-card
//   面板：[data-fg="copilot"][data-open] → 否則找「展開 … Copilot 面板」按鈕

// Node globals 由 root eslint.config.js 的 apps/*/scripts/**/*.cjs 區段提供；
// document 只出現在 page.evaluate（瀏覽器端）回呼內。
/* global document, window, requestAnimationFrame */

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
// 只命中一台（烤爐 04）的查詢；名稱來源 apps/web/src/domains/monitoring/lib/machine-labels.ts。
const DEFAULT_SEARCH = "烤爐";
// mock 每 240 tick（50ms／tick ≈ 12 秒）出現一次 press-02 critical 尖峰，持續約 1.45 秒；等一整個週期多一點。
const DEFAULT_PULSE_WAIT_MS = 13000;
const TOLERANCE_PX = 0.5;
const RECT_FIELDS = ["x", "y", "width", "height"];
const H_FIELDS = ["x", "width"];
const HOVER_SETTLE_MS = 250; // 卡片 transition 為 150ms
const PULSE_SAMPLES = 7;
const PULSE_INTERVAL_MS = 200;
const MAX_VIOLATIONS_PER_STEP = 12;

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
      "  --viewports        五 viewport × 兩主題 × Copilot 面板展開，共 10 張，並量測 layout shift（SC-004）",
      "  --readme           README 功能截圖（尚未實作，見 T070）",
      "",
      "選項：",
      `  --url <url>        dev server 位址（預設 ${DEFAULT_URL}）`,
      `  --out <dir>        輸出目錄（預設 apps/web/.screenshots）`,
      `  --settle <ms>      載入後等待遙測到齊的毫秒數（預設 ${DEFAULT_SETTLE_MS}）`,
      `  --search <query>   FR-015 量測用、只命中一台的搜尋字串（預設「${DEFAULT_SEARCH}」）`,
      `  --pulse-wait <ms>  等待 critical 卡片出現的上限（預設 ${DEFAULT_PULSE_WAIT_MS}；0＝只看當下）`,
      "  --no-fail          有 violation 時仍以 0 結束（只報告）",
      "  --only <WxH,...>   只跑指定 viewport（例 768x1024,390x844；除錯用）",
      "",
      "環境變數：PLAYWRIGHT_CHROMIUM＝Chromium 可執行檔路徑（未設定時自動尋找 ms-playwright 目錄）",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const opts = {
    mode: null,
    url: DEFAULT_URL,
    out: DEFAULT_OUT,
    settle: DEFAULT_SETTLE_MS,
    search: DEFAULT_SEARCH,
    pulseWait: DEFAULT_PULSE_WAIT_MS,
    only: null,
    fail: true,
  };
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
      case "--search": {
        const query = next().trim();
        if (query === "") throw new UserError("--search 不能是空字串");
        opts.search = query;
        break;
      }
      case "--pulse-wait": {
        const ms = Number(next());
        if (!Number.isInteger(ms) || ms < 0) throw new UserError("--pulse-wait 必須是非負整數（毫秒）");
        opts.pulseWait = ms;
        break;
      }
      case "--only": {
        const names = next().split(",").map((s) => s.trim());
        const known = VIEWPORTS.map((vp) => `${vp.width}x${vp.height}`);
        const unknown = names.filter((n) => !known.includes(n));
        if (unknown.length > 0) throw new UserError(`--only 未知 viewport：${unknown.join("、")}（可用 ${known.join("、")}）`);
        opts.only = names;
        break;
      }
      case "--no-fail":
        opts.fail = false;
        break;
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

// ---------- layout 量測（T063／SC-004） ----------

/**
 * 在雙 requestAnimationFrame 之後取 rect（第一幀讓樣式／版面提交，第二幀才讀），避免量到 transition 中途。
 * 卡片以 data-machine 為 key、stage 欄以 data-stage 為 key；鉤子缺席時退回索引。
 */
async function measureLayout(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const flag = (el, name) => el.hasAttribute(name) && el.getAttribute(name) !== "false";
            // x／y 換成「內容座標」：加回各層祖先與 window 的捲動量，捲動（hover 的 scrollIntoView、
            // 點擊時的自動捲動）就不會被誤判為 layout shift；viewportX／viewportY 保留原始視窗座標給溢出檢查。
            const rectOf = (el) => {
              const r = el.getBoundingClientRect();
              let sx = window.scrollX;
              let sy = window.scrollY;
              for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
                sx += p.scrollLeft;
                sy += p.scrollTop;
              }
              return { x: r.x + sx, y: r.y + sy, width: r.width, height: r.height, viewportX: r.x, viewportY: r.y };
            };
            const panel = document.querySelector('[data-fg="copilot"]');
            const topology = document.querySelector('[data-fg="stage-topology"]');
            resolve({
              document: {
                scrollWidth: document.documentElement.scrollWidth,
                clientWidth: document.documentElement.clientWidth,
              },
              topologyLayout: topology ? topology.getAttribute("data-layout") : null,
              copilotOpen: panel ? flag(panel, "data-open") : null,
              cards: Array.from(document.querySelectorAll(".machine-card")).map((el, index) => ({
                key: el.getAttribute("data-machine") || `#${index}`,
                machine: el.getAttribute("data-machine"),
                state: el.getAttribute("data-state"),
                latch: el.getAttribute("data-latch"),
                selected: flag(el, "data-selected"),
                ...rectOf(el),
              })),
              stages: Array.from(document.querySelectorAll('[data-fg="stage"]')).map((el, index) => ({
                key: el.getAttribute("data-stage") || `#${index}`,
                cardCount: el.querySelectorAll(".machine-card").length,
                ...rectOf(el),
              })),
            });
          }),
        );
      }),
  );
}

const fmt = (n) => (Math.round(n * 10) / 10).toString();

/**
 * 依 key 比對兩組 rect，回傳差值描述（超過容差的欄位、消失或新增的項目）。
 * 卡片的 data-state／data-latch 前後不同時附在描述後，方便判斷差值來源是互動還是 mock 狀態變化。
 * `requireSameSet: false`（搜尋過濾中）只比兩邊都有的項目。
 */
function diffRects(label, before, after, fields, { requireSameSet = true } = {}) {
  const diffs = [];
  const afterByKey = new Map(after.map((item) => [item.key, item]));
  for (const b of before) {
    const a = afterByKey.get(b.key);
    if (!a) {
      if (requireSameSet) diffs.push(`${label} ${b.key} 消失`);
      continue;
    }
    const changed = fields.filter((f) => Math.abs(a[f] - b[f]) > TOLERANCE_PX);
    if (changed.length > 0) {
      const detail = changed.map((f) => `${f} ${fmt(b[f])}→${fmt(a[f])}`).join("、");
      const state = b.state !== undefined && (b.state !== a.state || b.latch !== a.latch)
        ? `（state ${b.state}/${b.latch}→${a.state}/${a.latch}）`
        : "";
      diffs.push(`${label} ${b.key} ${detail}${state}`);
    }
  }
  if (requireSameSet) {
    const beforeKeys = new Set(before.map((item) => item.key));
    for (const a of after) if (!beforeKeys.has(a.key)) diffs.push(`${label} ${a.key} 新出現`);
  }
  return diffs;
}

/** 卡片與 stage 欄一起比對全部欄位（x／y／width／height）。 */
const diffLayout = (label, before, after) => [
  ...diffRects(`${label} 卡片`, before.cards, after.cards, RECT_FIELDS),
  ...diffRects(`${label} 欄`, before.stages, after.stages, RECT_FIELDS),
];

const result = (diffs, extra = {}) => ({ status: diffs.length > 0 ? "fail" : "pass", diffs, ...extra });
const skipped = (reason, extra = {}) => ({ status: "skipped", reason, diffs: [], ...extra });

/** 1. 橫向溢出：document 不可橫向捲動，卡片與欄不得超出視窗左右緣（抓內部容器的橫向溢出）。 */
function checkOverflow(layout) {
  const diffs = [];
  const { scrollWidth, clientWidth } = layout.document;
  if (scrollWidth > clientWidth + TOLERANCE_PX) diffs.push(`overflow document scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`);
  const outside = (label, items) => {
    for (const item of items) {
      const right = item.viewportX + item.width;
      if (item.viewportX < -TOLERANCE_PX || right > clientWidth + TOLERANCE_PX) {
        diffs.push(`overflow ${label} ${item.key} 超出視窗（x ${fmt(item.viewportX)}、right ${fmt(right)}、視窗寬 ${clientWidth}）`);
      }
    }
  };
  outside("卡片", layout.cards);
  outside("欄", layout.stages);
  return result(diffs, { scrollWidth, clientWidth });
}

/**
 * 記下卡片所在可捲動容器與 window 的捲動位置（hover 逐張 scrollIntoView 會改動），量完還原，
 * 讓第二個主題的截圖與第一個同一畫面。
 */
async function saveScroll(page) {
  await page.evaluate(() => {
    const saved = [];
    const seen = new Set();
    for (const card of document.querySelectorAll(".machine-card")) {
      for (let el = card.parentElement; el && el !== document.documentElement; el = el.parentElement) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) saved.push([el, el.scrollTop, el.scrollLeft]);
      }
    }
    window.__fgSavedScroll = { saved, x: window.scrollX, y: window.scrollY };
  });
}

async function restoreScroll(page) {
  await page.evaluate(() => {
    const state = window.__fgSavedScroll;
    if (!state) return;
    for (const [el, top, left] of state.saved) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
    window.scrollTo(state.x, state.y);
    delete window.__fgSavedScroll;
  });
}

/** 卡片中心點是否真的落在卡片上（手機 bottom-sheet、平板遮罩會蓋住卡片）。 */
async function cardCenter(card) {
  return card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, reachable: Boolean(hit) && el.contains(hit) };
  });
}

/**
 * 收掉搜尋：清空查詢、覆蓋模式按「收回」、把焦點移開。每一步都給短逾時並吞錯——
 * 覆蓋收回後輸入框會卸載，locator 操作若用預設逾時會白等。
 */
async function clearSearch(page, input, via) {
  if ((await input.count()) > 0) await input.fill("", { timeout: 2000 }).catch(() => {});
  if (via === "overlay") {
    const close = page.locator('[data-fg="search-overlay"] button:visible').first();
    if ((await close.count()) > 0) await close.dispatchEvent("click", undefined, { timeout: 2000 }).catch(() => {});
  }
  await page.evaluate(() => {
    if (document.activeElement && typeof document.activeElement.blur === "function") document.activeElement.blur();
  });
}

/**
 * 2. 搜尋過濾前／中／清除後（FR-015）。
 * 工具列段位依「工具列自身寬度」決定（TopBar.vue）：< 640 為 compact，搜尋收成圖示鈕
 * `[data-fg="search-toggle"]`，點開後是覆蓋整條工具列的絕對定位輸入框（不推擠版面）。
 * 768×1024 面板展開時工具列也在 compact，所以一般輸入框看不到時改走覆蓋式搜尋；兩者都找不到才記 skipped。
 * 點擊一律用 dispatchEvent：768–1023 sheet 展開時遮罩會蓋住工具列（同 applyTheme）。
 * 有差值一律 fail；沒有差值但查詢沒構成 FR-015 情境（命中 0 台或全部、沒有任何一欄被清空）時記 skipped。
 */
async function measureSearch(page, query) {
  const input = page.locator('input[aria-label="搜尋機台"]:visible').first();
  const toggle = page.locator('[data-fg="search-toggle"]:visible').first();
  const hasInput = (await input.count()) > 0;
  if (!hasInput && (await toggle.count()) === 0) return skipped("找不到可見的搜尋框或搜尋圖示鈕");
  const via = hasInput ? "input" : "overlay";

  // 基準在點開覆蓋之前量：覆蓋本身也不該推擠版面，一併納入「清除後」比對。
  const before = await measureLayout(page);
  let filtered = null;
  try {
    if (!hasInput) {
      await toggle.dispatchEvent("click");
      await sleep(200);
      if ((await input.count()) === 0) return skipped("點搜尋圖示鈕後沒有出現搜尋框");
    }
    await input.fill(query);
    await sleep(300);
    filtered = await measureLayout(page);
  } finally {
    // 不論中途是否出錯，都清掉過濾並收回覆蓋，避免後續量測與下一個主題的截圖停在過濾狀態。
    await clearSearch(page, input, via);
  }
  await sleep(300);
  const after = await measureLayout(page);

  const diffs = [];
  if (filtered.stages.length !== before.stages.length) {
    diffs.push(`search 過濾中 stage 欄數 ${before.stages.length}→${filtered.stages.length}`);
  }
  // 過濾中：欄高隨內容變屬預期（堆疊模式下 y 也會跟著變），只比 x／width；留下的卡片在原欄內，x／寬／高不變。
  diffs.push(...diffRects("search 過濾中 欄", before.stages, filtered.stages, H_FIELDS));
  diffs.push(
    ...diffRects("search 過濾中 卡片", before.cards, filtered.cards, ["x", "width", "height"], { requireSameSet: false }),
  );
  // 堆疊模式下欄的 y 會變，但順序必須維持由上而下（空欄不得塌掉或跑位）。
  if (filtered.topologyLayout === "stacked") {
    for (let i = 1; i < filtered.stages.length; i += 1) {
      const prev = filtered.stages[i - 1];
      const cur = filtered.stages[i];
      if (cur.y <= prev.y + TOLERANCE_PX) {
        diffs.push(`search 過濾中 欄 ${cur.key} y ${fmt(cur.y)} 未在 ${prev.key}（y ${fmt(prev.y)}）之下`);
      }
    }
  }
  // 清除後：全部卡片與欄回到過濾前的位置與尺寸。
  diffs.push(...diffLayout("search 清除後", before, after));

  const extra = {
    query,
    via,
    visibleWhileFiltered: filtered.cards.map((c) => c.key),
    emptyStagesWhileFiltered: filtered.stages.filter((s) => s.cardCount === 0).map((s) => s.key),
    stagesWhileFiltered: filtered.stages,
  };
  if (diffs.length > 0) return result(diffs, extra);
  if (filtered.cards.length === 0 || filtered.cards.length === before.cards.length) {
    return skipped(`查詢「${query}」命中 ${filtered.cards.length} 台（共 ${before.cards.length} 台），沒有真的過濾`, extra);
  }
  if (extra.emptyStagesWhileFiltered.length === 0) {
    return skipped(`查詢「${query}」沒有清空任何一欄，不構成 FR-015 的空欄情境`, extra);
  }
  return result(diffs, extra);
}

/**
 * 3. critical 脈動：同一張卡片在脈動週期內 rect 不變；另比對基準 → critical 的狀態變化，
 * 並記錄實際觀察到的狀態轉換（基準 → 各取樣）。基準已是 critical 時標「未涵蓋狀態變化」。
 */
async function measurePulse(page, baseline, waitMs) {
  const critical = page.locator('.machine-card[data-state="critical"]');
  const deadline = Date.now() + waitMs;
  while ((await critical.count()) === 0 && Date.now() < deadline) await sleep(200);
  if ((await critical.count()) === 0) return skipped(`${waitMs}ms 內沒有 critical 卡片`);

  const samples = [];
  for (let i = 0; i < PULSE_SAMPLES; i += 1) {
    if (i > 0) await sleep(PULSE_INTERVAL_MS);
    samples.push(await measureLayout(page));
  }
  const diffs = [];
  for (let i = 1; i < samples.length; i += 1) diffs.push(...diffLayout(`pulse 取樣 ${i}`, samples[0], samples[i]));
  // 狀態變化（healthy／warning → critical，含 latch 標記出現）不得改變卡片尺寸與位置（spec FR-031）。
  diffs.push(...diffLayout("pulse 基準→critical", baseline, samples[0]));

  // 每張卡片的狀態序列（基準 + 各取樣，去掉連續重複），有變化者記為一條轉換。
  const transitions = [];
  for (const card of baseline.cards) {
    const seq = [card.state];
    for (const s of samples) {
      const state = s.cards.find((c) => c.key === card.key)?.state;
      if (state !== undefined && state !== seq[seq.length - 1]) seq.push(state);
    }
    if (seq.length > 1) transitions.push(`${card.key}: ${seq.join("→")}`);
  }
  const criticalKeys = samples[0].cards.filter((c) => c.state === "critical").map((c) => c.key);
  const alreadyCritical = criticalKeys.filter((key) => baseline.cards.find((c) => c.key === key)?.state === "critical");
  return result([...new Set(diffs)], {
    criticalCards: criticalKeys,
    transitions,
    note:
      criticalKeys.length > 0 && alreadyCritical.length === criticalKeys.length
        ? "基準已是 critical：未涵蓋狀態變化（只量到脈動本身）"
        : undefined,
  });
}

/**
 * 用 CDP `CSS.forcePseudoState` 強制卡片進入 :hover。
 * 給「中心點被面板遮住」的卡片用：768×1024 的 sheet 遮罩、390×844 的 bottom-sheet 會蓋住主區，
 * 真實滑鼠移過去只會 hover 到遮罩。真實 hover 會讓整條祖先鏈都 :hover（卡片外層的 `.group` 靠它觸發
 * group-hover 的診斷鈕），所以卡片與其祖先（到 body 為止）一起強制。強制狀態綁在該 CDP session，detach 即清除。
 */
async function createHoverForcer(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  // 建 nodeId → parentId 對照，供卡片往上找祖先鏈。
  const parentOf = new Map();
  let bodyId = null;
  const walk = (node) => {
    if (node.nodeName === "BODY") bodyId = node.nodeId;
    for (const child of node.children || []) {
      parentOf.set(child.nodeId, node.nodeId);
      walk(child);
    }
  };
  walk(root);
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".machine-card" });
  const chainOf = (nodeId) => {
    const chain = [];
    for (let id = nodeId; id !== undefined && id !== bodyId && id !== root.nodeId; id = parentOf.get(id)) chain.push(id);
    return chain;
  };
  return {
    set: async (index, on) => {
      for (const nodeId of chainOf(nodeIds[index])) {
        await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: on ? ["hover"] : [] });
      }
    },
    dispose: () => cdp.detach().catch(() => {}),
  };
}

/** 卡片外層（含 group-hover 的診斷鈕）的樣式指紋：用來確認 hover 真的生效，避免「沒 hover 到」的假通過。 */
async function hoverSignature(card) {
  return card.evaluate((el) => {
    const scope = el.parentElement || el;
    return [scope, ...scope.querySelectorAll("*")]
      .map((node) => {
        const s = window.getComputedStyle(node);
        return `${s.opacity}|${s.borderColor}|${s.backgroundColor}|${s.color}`;
      })
      .join(";");
  });
}

/** 4. hover：逐張卡片，滑鼠移開與 hover 後各量一次全體 rect（可達用真實滑鼠，被遮住用 CDP 強制 :hover）。 */
async function measureHover(page) {
  const cards = page.locator(".machine-card");
  const count = await cards.count();
  const diffs = [];
  const via = {};
  const noEffect = [];
  let forcer = null;
  let current = null;
  try {
    for (let i = 0; i < count; i += 1) {
      const card = cards.nth(i);
      const key = (await card.getAttribute("data-machine")) || `#${i}`;
      current = key;
      await card.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await sleep(HOVER_SETTLE_MS);
      const before = await measureLayout(page);
      const styleBefore = await hoverSignature(card);
      const point = await cardCenter(card);
      if (point.reachable) {
        await page.mouse.move(point.x, point.y);
        via[key] = "mouse";
      } else {
        forcer = forcer || (await createHoverForcer(page));
        await forcer.set(i, true);
        via[key] = "cdp-force";
      }
      await sleep(HOVER_SETTLE_MS);
      const after = await measureLayout(page);
      if ((await hoverSignature(card)) === styleBefore) noEffect.push(key);
      if (!point.reachable) await forcer.set(i, false);
      diffs.push(...diffLayout(`hover ${key}`, before, after));
    }
  } catch (err) {
    // 標出卡在哪張卡片，交給 measureAll 記為 fail。
    if (err && err.message) err.message = `（卡片 ${current}）${err.message}`;
    throw err;
  } finally {
    if (forcer) await forcer.dispose();
    await page.mouse.move(0, 0);
  }
  // 觸控裝置（390×844 以 hasTouch 模擬）的 [@media(hover:none)] 讓診斷鈕常駐，hover 本來就可能沒有樣式變化，只記錄不判失敗。
  return result(diffs, { via, noVisibleHoverEffect: noEffect });
}

/** 點卡片：中心點可達時用真實點擊（左上內距處，避開診斷鈕），被遮住時退回 dispatchEvent。 */
async function clickCard(page, card) {
  // 先捲入視野再判斷可達性：視野外的卡片 elementFromPoint 取不到，會被誤判為「被遮住」。
  await card.scrollIntoViewIfNeeded();
  const point = await cardCenter(card);
  if (point.reachable) await card.click({ position: { x: 12, y: 12 } });
  else await card.dispatchEvent("click");
  await page.mouse.move(0, 0);
  await sleep(500);
  return point.reachable ? "click" : "dispatchEvent";
}

/**
 * 5. 選取：面板已展開時改選另一張卡片不應有版面變化；量完點回原卡片。
 * 面板收合時選台會把它展開（屬預期的版面變化），所以先確保展開；展開不了就記 skipped。
 */
async function measureSelected(page, label) {
  const cards = page.locator(".machine-card");
  const count = await cards.count();
  if (count < 2) return skipped("卡片不足兩張，無法改選");
  let before = await measureLayout(page);
  if (before.copilotOpen === false) {
    await ensureCopilotOpen(page, label);
    before = await measureLayout(page);
    if (before.copilotOpen === false) return skipped("Copilot 面板收合且無法展開，選台會改變版面，不量");
  }
  const originalIndex = before.cards.findIndex((c) => c.selected);
  const targetIndex = before.cards.findIndex((c) => !c.selected);
  if (targetIndex < 0) return skipped("找不到未選取的卡片");

  await page.mouse.move(0, 0);
  const how = await clickCard(page, cards.nth(targetIndex));
  const after = await measureLayout(page);
  const diffs = [];
  if (!after.cards[targetIndex]?.selected) diffs.push(`selected ${before.cards[targetIndex].key} 點擊後未變成 data-selected`);
  if (before.copilotOpen !== after.copilotOpen) diffs.push(`selected 面板 data-open ${before.copilotOpen}→${after.copilotOpen}`);
  diffs.push(...diffLayout(`selected ${before.cards[targetIndex].key}`, before, after));

  // 還原原本的選取，讓下一個主題的截圖維持同一畫面。
  if (originalIndex >= 0) await clickCard(page, cards.nth(originalIndex));
  return result(diffs, {
    from: originalIndex >= 0 ? before.cards[originalIndex].key : null,
    to: before.cards[targetIndex].key,
    via: how,
    copilotOpen: before.copilotOpen,
  });
}

/** 依序跑五項量測；個別量測拋錯時記為 fail，不中斷其他 viewport。 */
async function measureAll(page, baseline, opts, label) {
  const measurements = { overflow: checkOverflow(baseline) };
  const steps = [
    ["search", () => measureSearch(page, opts.search)],
    ["pulse", () => measurePulse(page, baseline, opts.pulseWait)],
    ["hover", () => measureHover(page)],
    ["selected", () => measureSelected(page, label)],
  ];
  await saveScroll(page);
  for (const [name, run] of steps) {
    try {
      measurements[name] = await run();
    } catch (err) {
      const message = err && err.message ? err.message.split("\n")[0] : String(err);
      measurements[name] = { status: "fail", diffs: [`${name} 量測失敗：${message}`] };
    }
  }
  await restoreScroll(page);
  await page.mouse.move(0, 0);
  await sleep(300);

  const violations = [];
  for (const m of Object.values(measurements)) {
    violations.push(...m.diffs.slice(0, MAX_VIOLATIONS_PER_STEP));
    if (m.diffs.length > MAX_VIOLATIONS_PER_STEP) violations.push(`…另 ${m.diffs.length - MAX_VIOLATIONS_PER_STEP} 筆（見 measurements）`);
  }
  return { measurements, violations };
}

// 與 measureAll 的執行順序一致。
const STEP_ORDER = ["overflow", "search", "pulse", "hover", "selected"];
const MARK = { pass: "✓", fail: "✗", skipped: "skipped" };

function printSummary(rows) {
  const header = ["viewport", "theme", ...STEP_ORDER];
  const widths = [11, 6, ...STEP_ORDER.map((s) => Math.max(s.length, 8))];
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log("");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(line([row.viewport, row.theme, ...STEP_ORDER.map((s) => MARK[row.measurements[s]?.status] ?? "?")]));
  }
  console.log("");
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
  const rows = [];
  try {
    for (const vp of VIEWPORTS.filter((v) => !opts.only || opts.only.includes(`${v.width}x${v.height}`))) {
      const name = `${vp.width}x${vp.height}`;
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        isMobile: Boolean(vp.mobile),
        hasTouch: Boolean(vp.mobile),
      });
      // 預設 30 秒逾時太長：元素卸載或被 HMR 換掉時，單一 locator 操作就會白等半分鐘。
      context.setDefaultTimeout(10000);
      // 導覽維持 30 秒：Vite 冷啟動時首頁編譯可能超過 10 秒。
      context.setDefaultNavigationTimeout(30000);
      try {
        const page = await context.newPage();
        // 干擾偵測：量測期間若 Vite HMR 更新、頁面重新導覽（其他人同時改 src/）或 WS 斷線，差值可能來自外部變動而非互動。
        const interference = { hmr: 0, navigations: 0, wsErrors: 0 };
        page.on("console", (m) => {
          if (m.type() === "error") log(`${name} console.error：${m.text().slice(0, 200)}`);
          if (/^\[vite\] (hot updated|page reload)/.test(m.text())) interference.hmr += 1;
          // api 被 watch 重啟時 WS 斷線，主區頂端會出現「重新連線中…」橫幅把整欄往下推，屬外部干擾。
          if (m.type() === "error" && m.text().includes("WebSocket")) interference.wsErrors += 1;
        });
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) interference.navigations += 1;
        });
        await page.goto(opts.url, { waitUntil: "networkidle" });
        await waitForCards(page);
        await sleep(opts.settle); // 等遙測到齊
        await selectMachine(page);
        await ensureCopilotOpen(page, name);

        for (const theme of THEMES) {
          await applyTheme(page, theme);
          const base = path.join(opts.out, `${name}-${theme}`);
          // 干擾計數器在截圖前歸零：基準 rect 取自截圖當下，截圖到量測結束之間的干擾都要算進來。
          interference.hmr = 0;
          interference.navigations = 0;
          interference.wsErrors = 0;
          await page.mouse.move(0, 0);
          await page.screenshot({ path: `${base}.png`, fullPage: false });
          const baseline = await measureLayout(page);
          const actualTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
          if (actualTheme !== theme) {
            log(`${name} 警告：要求主題 ${theme}，實際 documentElement.dataset.theme 為 ${actualTheme}`);
          }
          const { measurements, violations } = await measureAll(page, baseline, opts, `${name}-${theme}`);
          const disturbed =
            interference.hmr + interference.navigations + interference.wsErrors > 0 ? { ...interference } : null;
          if (disturbed) {
            log(`${name}-${theme} 注意：量測期間 Vite HMR ${disturbed.hmr} 次、頁面導覽 ${disturbed.navigations} 次、WS 錯誤 ${disturbed.wsErrors} 次，violation 可能來自外部變動，請重跑確認`);
          }
          const payload = {
            viewport: { width: vp.width, height: vp.height },
            theme,
            actualTheme,
            url: opts.url,
            capturedAt: new Date().toISOString(),
            tolerancePx: TOLERANCE_PX,
            ...baseline,
            measurements,
            violations,
            interference: disturbed,
          };
          fs.writeFileSync(`${base}.json`, `${JSON.stringify(payload, null, 2)}\n`);
          written += 1;
          rows.push({ viewport: name, theme, measurements, violations });
          log(`寫入 ${path.basename(base)}.png／.json（${baseline.cards.length} 張卡片，${violations.length} 筆 violation）`);
          for (const v of violations) log(`  ✗ ${v}`);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  log(`完成：${written} 張截圖`);
  printSummary(rows);
  const steps = rows.flatMap((row) => Object.values(row.measurements));
  const total = steps.reduce((sum, m) => sum + m.diffs.length, 0);
  const skippedCount = steps.filter((m) => m.status === "skipped").length;
  const skippedNote = skippedCount > 0 ? `；${skippedCount} 項 skipped（原因見各 .json 的 measurements.*.reason）` : "；0 項 skipped";
  if (total > 0) {
    log(`SC-004：${total} 筆 violation${skippedNote}（細節見各 .json 的 violations／measurements）`);
    if (opts.fail) process.exitCode = 1;
  } else {
    log(`SC-004：layout shift 與橫向溢出 0 件${skippedNote}`);
  }
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
