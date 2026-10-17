// flow-gatekeeper 監控台截圖劇本（feature 013，research R11；雛形 T002，T063 擴充 --viewports，T070 完成 --readme）。
//
// 用法（於 repo 根目錄；需先起 api 與 web dev server）：
//   node apps/web/scripts/screenshots.cjs --viewports [--url <url>] [--out <dir>] [--settle <ms>]
//     [--search <query>] [--pulse-wait <ms>] [--no-fail] [--only <WxH,...>]
//   node apps/web/scripts/screenshots.cjs --readme [--url <url>] [--out <dir>] [--settle <ms>] [--search <query>] [--no-fail]
//   各選項說明見 --help。
//
// --readme（T070；spec SC-012）：README「功能逐項展示」的 14 張截圖，預設輸出到 docs/screenshots/：
//   12 張功能截圖（淺色）＋ dark-theme.png（深色全景）＋ topology.png（拓樸區裁切）。每組情境開一個乾淨 context
//   （localStorage 全空 → 淺色主題、AI 診斷面板無手動收合偏好），依序：
//   1. 1440×900（裝置像素比 2）：monitoring-live（載入滿 20 秒，走勢線有內容）→ monitoring-states（等 press-02 嚴重與
//      oven-04 警告同屏，mock 每 36 秒一次）→ 從同一張全景裁切 fleet-health（機群健康＋異常摘要列）、
//      event-stream、topology（四張同一瞬間）→ monitoring-search（查詢「p」，前處理欄清空、欄位保留）→ monitoring-selected
//      （先選取 press-02、面板自動展開，等它嚴重時拍）→ 等 press-02 回到正常再按「診斷」：copilot-streaming（骨架填入中途）、
//      copilot-completed → 再等一次回到正常後按工具列「診斷」：copilot-cached（「快取 · 耗時」並列上一次耗時）→
//      dark-theme（切深色拍全景後切回）→ copilot-failed（攔截 POST /diagnoses 回 503，重現可讀錯誤與「重試」）。
//      「回到正常再診斷」是為了讓兩次診斷的快取簽章（含最近一筆 state）相同，第二次才會命中快取。
//   2. 1440×900：monitoring-reconnecting-stale——以 page.routeWebSocket 代理 /ws，在 press-02 嚴重時切斷並拒絕重連，
//      等全部卡片顯示「停滯」再拍；不必關掉 api，也不影響其他連線。
//   3. 390×844（裝置像素比 3、觸控）：responsive-mobile——選取 press-02 開 bottom-sheet、診斷完成後拍。
//   前置：worker 需有效 GEMINI_API_KEY；先執行 ./scripts/demo-reset.ps1 清 ai-cache，否則第一次診斷直接命中快取、
//   拍不到串流（copilot-streaming／copilot-completed 會記為缺漏）。拍不到的截圖不寫檔（保留舊檔），
//   結束時列出缺漏並以 exit 1 結束（--no-fail 只報告）。
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
//      （768／1024 sheet 遮罩、390 bottom-sheet）改用 CDP CSS.forcePseudoState 強制 :hover。
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
// document、performance、MutationObserver 等只出現在 page.evaluate（瀏覽器端）回呼內。
/* global document, window, requestAnimationFrame, performance, MutationObserver */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { COPILOT_STATUS_CHIPS, UserError, findChromium } = require("./lib/browser.cjs");

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

// --readme（T070）
const DEFAULT_README_OUT = path.resolve(__dirname, "..", "..", "..", "docs", "screenshots");
const README_DESKTOP = { width: 1440, height: 900, scale: 2 };
const README_MOBILE = { width: 390, height: 844, scale: 3, mobile: true };
// 命中 press-02、pack-03（machine id 含 p）：成型烘烤、包裝分揀各留一台，前處理欄清空但保留空狀態（FR-015）。
const DEFAULT_README_SEARCH = "p";
// 示範機台：mock 每 240 tick（約 12 秒）一次 critical 尖峰；oven-04 每 180 tick 一次 warning，兩者每 720 tick（36 秒）重疊約 1.45 秒。
const README_MACHINE = "press-02";
const README_WARNING_MACHINE = "oven-04";
// 依劇本執行順序；也是結束時總表的列順序。
const README_SHOTS = [
  "monitoring-live",
  "monitoring-states",
  "fleet-health",
  "event-stream",
  "topology",
  "monitoring-search",
  "monitoring-selected",
  "copilot-streaming",
  "copilot-completed",
  "copilot-cached",
  "dark-theme",
  "copilot-failed",
  "monitoring-reconnecting-stale",
  "responsive-mobile",
];
const LIVE_WARMUP_MS = 20000; // 全景前至少載入 20 秒，讓近 60 秒走勢線有內容
const STATES_WAIT_MS = 40000; // 等嚴重與警告同屏的上限（一輪 36 秒）
const SPIKE_WAIT_MS = 30000; // 等 press-02 尖峰或回復的上限（一輪 12 秒，給兩輪多）
const HISTORY_FLUSH_MS = 2000; // api 每 1 秒 flush 遙測進 Mongo；回到正常後多等一輪，worker 讀到的最近 state 才是 healthy
const DIAGNOSIS_TIMEOUT_MS = 60000;
const STALE_WAIT_MS = 25000; // 停滯門檻 10 秒，每秒 tick 重算
const RATIO_WAIT_MS = 15000;
const SKELETON_TARGET_FIELDS = 2; // 串流骨架拍到 2／5 欄已填入就停（摘要、嚴重度），建議動作仍在填、可能原因與證據為佔位
const CLIP_PADDING_PX = 8;
// 卡片狀態色的過渡（MachineNodeCard `transition-colors duration-150`）：data-state 一切換就判定為嚴重／警告，
// 底色仍在從前一態（例如選取的深青水洗）過渡到 crit-bg／warn-bg；截圖前距最近一次狀態切換至少 150ms＋餘裕，避免拍到過渡中途幀。
// 時間一律以頁面時鐘（performance.now）計：畫面上的嚴重態實測只有約 450ms，而 2 倍像素比的 page.screenshot 約要 300ms 才回來，
// 用 Node 端輪詢加固定 sleep 會錯過整段尖峰。
const CARD_SETTLE_MS = 250;
// page.screenshot 送出後到實際擷取畫面的上限估計：這段時間內有卡片狀態切換就視為拍到過渡，重拍。
const FRAME_GRACE_MS = 50;
const WS_ROUTE = /\/ws$/;
const SIMULATED_CLOSE = { code: 4000, reason: "screenshots: 模擬斷線" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(`[screenshots] ${msg}`);

function printUsage() {
  console.log(
    [
      "用法：node apps/web/scripts/screenshots.cjs <模式> [選項]",
      "",
      "模式：",
      "  --viewports        五 viewport × 兩主題 × Copilot 面板展開，共 10 張，並量測 layout shift（SC-004）",
      "  --readme           README「功能逐項展示」14 張：12 張功能（淺色）＋ dark-theme ＋ topology（SC-012）",
      "                     前置：worker 有效 GEMINI_API_KEY，並先 ./scripts/demo-reset.ps1 清 AI 快取（否則拍不到串流）",
      "",
      "選項：",
      `  --url <url>        dev server 位址（預設 ${DEFAULT_URL}）`,
      "  --out <dir>        輸出目錄（預設 --viewports：apps/web/.screenshots；--readme：docs/screenshots）",
      `  --settle <ms>      載入後等待遙測到齊的毫秒數（預設 ${DEFAULT_SETTLE_MS}）`,
      `  --search <query>   --viewports：FR-015 量測用、只命中一台的搜尋字串（預設「${DEFAULT_SEARCH}」）`,
      `                     --readme：monitoring-search 的查詢（預設「${DEFAULT_README_SEARCH}」）`,
      `  --pulse-wait <ms>  --viewports：等待 critical 卡片出現的上限（預設 ${DEFAULT_PULSE_WAIT_MS}；0＝只看當下）`,
      "  --no-fail          有 violation（--viewports）或缺漏截圖（--readme）時仍以 0 結束（只報告）",
      "  --only <WxH,...>   --viewports：只跑指定 viewport（例 768x1024,390x844；除錯用）",
      "",
      "環境變數：PLAYWRIGHT_CHROMIUM＝Chromium 可執行檔路徑（未設定時自動尋找 ms-playwright 目錄）",
      "          PLAYWRIGHT_BROWSERS_PATH＝自訂 ms-playwright 目錄（優先於預設位置）",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const opts = {
    mode: null,
    url: DEFAULT_URL,
    out: null, // 依模式決定預設（迴圈後補）
    settle: DEFAULT_SETTLE_MS,
    search: null, // 同上
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
  const readme = opts.mode === "--readme";
  if (readme && opts.only) throw new UserError("--only 只適用 --viewports");
  if (opts.out === null) opts.out = readme ? DEFAULT_README_OUT : DEFAULT_OUT;
  if (opts.search === null) opts.search = readme ? DEFAULT_README_SEARCH : DEFAULT_SEARCH;
  return opts;
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
      // 用 dispatchEvent 而非 click()：768–1365 寬度下 sheet 展開時，rail 上的切換鈕被遮罩（z-40）蓋住，
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
 * 點擊一律用 dispatchEvent：768–1365 sheet 展開時遮罩會蓋住工具列（同 applyTheme）。
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
 * 給「中心點被面板遮住」的卡片用：768×1024 與 1024×768 的 sheet 遮罩、390×844 的 bottom-sheet 會蓋住主區，
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

// ---------- README 截圖（T070） ----------

/** 每 intervalMs 呼叫一次 fn，回傳第一個 truthy 結果；逾時回 null。 */
async function pollUntil(fn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/**
 * 等 want（[{ id, state }]，全部同時成立）「重新成立」：先等它不成立，再等它成立，在頁面內以 requestAnimationFrame 逐幀判定，
 * 成立後再等 CARD_SETTLE_MS 讓卡片底色過渡完才回來。回傳成立當下的頁面時鐘（逾時回 null）。
 * 條件一開始就成立時多半已近尾聲，從新的一次開頭拍才有餘裕。
 */
async function waitFresh(page, want, timeoutMs) {
  return page.evaluate(
    ({ want: w, timeoutMs: limit, settle }) =>
      new Promise((resolve) => {
        const holds = () =>
          w.every(({ id, state }) => {
            const el = document.querySelector(`.machine-card[data-machine="${id}"]`);
            return el !== null && el.getAttribute("data-state") === state;
          });
        let armed = !holds();
        const deadline = performance.now() + limit;
        const tick = () => {
          const now = performance.now();
          if (!holds()) armed = true;
          else if (armed) {
            setTimeout(() => resolve(now), settle);
            return;
          }
          if (now > deadline) {
            resolve(null);
            return;
          }
          requestAnimationFrame(tick);
        };
        tick();
      }),
    { want, timeoutMs, settle: CARD_SETTLE_MS },
  );
}

const cardOf = (page, id) => page.locator(`.machine-card[data-machine="${id}"]`).first();
const cardState = (page, id) => cardOf(page, id).getAttribute("data-state", { timeout: 2000 }).catch(() => null);

/** 截圖紀錄：拍到才寫檔（拍不到時保留舊檔），結束時依 README_SHOTS 順序列總表。 */
function createShotLog(out) {
  const results = new Map(README_SHOTS.map((name) => [name, { status: "missing", reason: "未執行" }]));
  return {
    results,
    write(name, buffer, note) {
      fs.writeFileSync(path.join(out, `${name}.png`), buffer);
      results.set(name, { status: "written", note });
      log(`寫入 ${name}.png${note ? `（${note}）` : ""}`);
    },
    miss(name, reason) {
      results.set(name, { status: "missing", reason });
      log(`✗ ${name}：${reason}`);
    },
  };
}

/** 一段劇本：拋錯時把這段負責、尚未寫入的截圖記為缺漏，不中斷其他段。 */
async function scene(shots, names, run) {
  try {
    await run();
  } catch (err) {
    const message = err && err.message ? err.message.split("\n")[0] : String(err);
    for (const name of names) if (shots.results.get(name).status !== "written") shots.miss(name, message);
  }
}

/** 開乾淨 context（localStorage 全空：淺色主題、AI 診斷面板無偏好）並載入；beforeGoto 供掛 route。 */
async function openReadmePage(browser, vp, opts, name, beforeGoto) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.scale,
    isMobile: Boolean(vp.mobile),
    hasTouch: Boolean(vp.mobile),
  });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(30000);
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") log(`${name} console.error：${m.text().slice(0, 200)}`);
  });
  if (beforeGoto) await beforeGoto(page);
  const loadedAt = Date.now();
  await page.goto(opts.url, { waitUntil: "networkidle" });
  await waitForCards(page);
  await installStateRecorder(page);
  await sleep(opts.settle);
  await applyTheme(page, "light");
  return { context, page, loadedAt };
}

/**
 * 從一張全景截圖切出多個範圍：在同一 context（同 viewport 與裝置像素比）開一頁，把全景以 CSS 原尺寸鋪滿，
 * 每個 clip 一張——裝置像素一對一，不重新取樣，也不必另裝影像處理套件。
 */
async function cropShot(context, vp, buffer, clips) {
  const page = await context.newPage();
  try {
    await page.setContent(
      `<!doctype html><html><body style="margin:0"><img id="shot" alt="" style="display:block;width:${vp.width}px;height:${vp.height}px" src="data:image/png;base64,${buffer.toString("base64")}"></body></html>`,
    );
    await page.locator("#shot").evaluate((img) => img.decode());
    const out = {};
    for (const [name, clip] of Object.entries(clips)) out[name] = await page.screenshot({ clip });
    return out;
  } finally {
    await page.close();
  }
}

/**
 * 在頁面裝卡片狀態切換紀錄器：MutationObserver 記下每次 data-state 變化的頁面時鐘，截圖前後據此判斷畫面上有沒有過渡中的卡片。
 */
async function installStateRecorder(page) {
  await page.evaluate(() => {
    if (window.__fgStateLog) return;
    const entries = [];
    window.__fgStateLog = entries;
    new MutationObserver((records) => {
      const t = performance.now();
      for (const r of records) {
        if (r.target.classList && r.target.classList.contains("machine-card")) entries.push(t);
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
  });
}

/** 頁面時鐘 from（不含）之後、to（含）之前有沒有卡片狀態切換。 */
const stateChangedBetween = (page, from, to) =>
  page.evaluate(({ a, b }) => (window.__fgStateLog || []).some((t) => t > a && t <= b), { a: from, b: to });

/** 把滑鼠移開、焦點移走，避免 hover／focus 樣式入鏡。 */
async function clearPointer(page) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    if (document.activeElement && typeof document.activeElement.blur === "function") document.activeElement.blur();
  });
}

/**
 * 截一張「沒有卡片在過渡」的圖：距最近一次卡片狀態切換不足 CARD_SETTLE_MS 就等到滿；
 * 截圖送出後 FRAME_GRACE_MS 內又有切換（可能拍到過渡起點）就重拍，最多 3 次。
 * 卡片狀態不受劇本控制（任何一張截圖當下都可能碰上尖峰開始或結束），所以每張都走這裡。
 */
async function capture(page, options = {}) {
  await clearPointer(page);
  let shot = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const since = await page.evaluate(() => {
      const entries = window.__fgStateLog || [];
      return entries.length > 0 ? performance.now() - entries[entries.length - 1] : Number.POSITIVE_INFINITY;
    });
    if (since < CARD_SETTLE_MS) await sleep(CARD_SETTLE_MS - since);
    const t0 = await page.evaluate(() => performance.now());
    shot = await page.screenshot(options);
    if (!(await stateChangedBetween(page, t0, t0 + FRAME_GRACE_MS))) return shot;
  }
  log("警告：截圖期間卡片狀態持續變化，保留最後一張");
  return shot;
}

/**
 * 在 want 成立的那段尖峰內截圖：waitFresh 等到新的一次成立且底色過渡完，立刻截圖；
 * 成立之後到截圖送出後 FRAME_GRACE_MS 之間有任何卡片切換（尖峰已結束或別台在過渡）就等下一次，最多 3 次。
 */
async function captureWhile(page, want, waitMs) {
  await clearPointer(page);
  let shot = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const enteredAt = await waitFresh(page, want, waitMs);
    const t0 = await page.evaluate(() => performance.now());
    shot = await page.screenshot();
    if (enteredAt !== null && !(await stateChangedBetween(page, enteredAt, t0 + FRAME_GRACE_MS))) return { shot, ok: true };
    log(`第 ${attempt} 次截圖時尖峰已結束或有卡片在過渡，等下一次`);
  }
  return { shot, ok: false };
}

/**
 * 多個元素可見部分的聯集外框（加 padding）：與每一層會裁切的祖先（overflow 非 visible）及視窗取交集，
 * 拓樸在捲動容器內，直接用 boundingBox 會拍到被截掉的部分。找不到元素時拋錯。
 */
async function visibleClip(page, selectors) {
  const box = await page.evaluate(
    ({ selectors: sels, padding }) => {
      const rects = [];
      for (const sel of sels) {
        const el = Array.from(document.querySelectorAll(sel)).find((node) => node.getClientRects().length > 0);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        let left = r.left;
        let top = r.top;
        let right = r.right;
        let bottom = r.bottom;
        for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
          const s = window.getComputedStyle(p);
          if (s.overflowX === "visible" && s.overflowY === "visible") continue;
          const c = p.getBoundingClientRect();
          left = Math.max(left, c.left);
          top = Math.max(top, c.top);
          right = Math.min(right, c.right);
          bottom = Math.min(bottom, c.bottom);
        }
        if (right > left && bottom > top) rects.push({ left, top, right, bottom });
      }
      if (rects.length === 0) return null;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const left = Math.max(0, Math.min(...rects.map((r) => r.left)) - padding);
      const top = Math.max(0, Math.min(...rects.map((r) => r.top)) - padding);
      const right = Math.min(vw, Math.max(...rects.map((r) => r.right)) + padding);
      const bottom = Math.min(vh, Math.max(...rects.map((r) => r.bottom)) + padding);
      return { x: left, y: top, width: right - left, height: bottom - top };
    },
    { selectors, padding: CLIP_PADDING_PX },
  );
  if (!box) throw new Error(`找不到可見的 ${selectors.join("、")}`);
  return box;
}

/**
 * 等 machineId 經歷一次異常（警告或嚴重）並回到正常，再多等一輪 history flush。
 * 診斷前這樣等，worker 組脈絡時讀到的最近 state 一定是 healthy，兩次診斷的快取簽章才會相同。
 */
async function waitForRecovery(page, machineId) {
  let sawSpike = false;
  const recovered = await pollUntil(
    async () => {
      const state = await cardState(page, machineId);
      if (state === "critical" || state === "warning") sawSpike = true;
      return sawSpike && state === "healthy";
    },
    SPIKE_WAIT_MS,
    100,
  );
  if (!recovered) {
    log(`警告：${SPIKE_WAIT_MS}ms 內沒等到 ${machineId} 由異常回到正常，改為目前正常即送出（兩次診斷的快取簽章可能不同）`);
    await pollUntil(async () => (await cardState(page, machineId)) === "healthy", SPIKE_WAIT_MS, 100);
  }
  await sleep(HISTORY_FLUSH_MS);
}

/** AI 診斷面板目前狀態：標頭狀態 chip、機台 id · 任務短碼、完成 meta 是否快取、骨架各欄填入狀態。 */
async function panelSnapshot(page) {
  return page.evaluate((status) => {
    const panel = document.querySelector('[data-fg="copilot"]');
    if (!panel) return null;
    const header = panel.querySelector("header");
    const chips = header ? Array.from(header.querySelectorAll("span")).map((el) => el.textContent.trim()) : [];
    // 文案 → 狀態對照見 lib/browser.cjs 的 COPILOT_STATUS_CHIPS（與 record-demo.cjs 共用）。
    const chip = chips.find((text) => text in status);
    const job = header ? header.querySelector(".font-mono") : null;
    const timing = panel.querySelector('[data-fg="timing"]');
    const skeleton = panel.querySelector('[data-fg="result-skeleton"]');
    const error = panel.querySelector("p.border-crit");
    return {
      error: error ? error.textContent.trim() : null,
      status: chip ? status[chip] : null,
      job: job ? job.textContent.trim() : null,
      cached: timing ? timing.getAttribute("data-cached") === "true" : null,
      fields: skeleton
        ? Array.from(skeleton.querySelectorAll("[data-field]")).map((el) => el.getAttribute("data-field-state"))
        : [],
    };
  }, COPILOT_STATUS_CHIPS);
}

/**
 * 觸發診斷：面板內有文字恰為「診斷」的主按鈕（閒置態）就按它，否則按工具列「主要動作」的診斷鈕。
 * 完成態面板另有次要鈕「再次診斷」（T073），精確比對「診斷」刻意不命中它，劇本在完成態一律走工具列鈕
 * （快取截圖 copilot-cached 的流程以工具列鈕為準，行為不變）。
 */
async function clickDiagnose(page) {
  const inPanel = page.locator('[data-fg="copilot"] button:visible', { hasText: /^\s*診斷\s*$/ }).first();
  const toolbar = page.locator('button[aria-label="診斷"]:visible').first();
  const target = (await inPanel.count()) > 0 ? inPanel : toolbar;
  if ((await target.count()) === 0) throw new Error("找不到可見的「診斷」按鈕");
  await target.click();
  await page.mouse.move(0, 0);
}

/**
 * 按「診斷」並等這一筆（任務短碼與按下前不同）收尾為已完成或失敗。
 * `streaming: true` 時在進行中每次有新欄位填入就截一張，拍到 SKELETON_TARGET_FIELDS 欄即停，回傳最後一張。
 */
async function runDiagnosis(page, { streaming = false } = {}) {
  const before = await panelSnapshot(page);
  await clickDiagnose(page);
  let streamingShot = null;
  let filled = 0;
  const deadline = Date.now() + DIAGNOSIS_TIMEOUT_MS;
  for (;;) {
    const snap = await panelSnapshot(page);
    const isNew = snap !== null && snap.job !== (before ? before.job : null);
    if (isNew && (snap.status === "completed" || snap.status === "failed")) return { ...snap, streamingShot };
    if (streaming && isNew && snap.status === "active" && filled < SKELETON_TARGET_FIELDS) {
      const complete = snap.fields.filter((state) => state === "complete").length;
      if (complete > filled && complete < snap.fields.length) {
        streamingShot = await page.screenshot();
        filled = complete;
      }
    }
    if (Date.now() >= deadline) return { ...(snap || {}), timedOut: true, streamingShot };
    await sleep(100);
  }
}

function diagnosisProblem(result) {
  if (result.timedOut) return `診斷 ${DIAGNOSIS_TIMEOUT_MS / 1000} 秒內未結束（worker 是否在跑？）`;
  if (result.status === "failed") return `診斷失敗：${result.error || "原因不明"}（檢查 worker log 與 GEMINI_API_KEY）`;
  return null;
}

/** 1440×900 主劇本：全景、三態、裁切三張、搜尋、選取、串流、完成、快取、深色、失敗。 */
async function shootDesktop(browser, opts, shots) {
  const { context, page, loadedAt } = await openReadmePage(browser, README_DESKTOP, opts, "1440x900");
  const shoot = async (name, options, note) => shots.write(name, await capture(page, options), note);
  try {
    await scene(shots, ["monitoring-live"], async () => {
      const ratio = page.locator('[data-fg="ratio"]:visible').first();
      const ready = await pollUntil(async () => {
        const text = (await ratio.textContent({ timeout: 2000 }).catch(() => null)) || "";
        return text.trim() !== "" && !text.includes("—");
      }, RATIO_WAIT_MS);
      if (!ready) log("警告：背壓 strip 的比值仍是「—」");
      const rest = LIVE_WARMUP_MS - (Date.now() - loadedAt);
      if (rest > 0) await sleep(rest);
      await shoot("monitoring-live");
    });

    await scene(shots, ["monitoring-states", "fleet-health", "event-stream", "topology"], async () => {
      // 尖峰只有約 1.45 秒：裁切範圍與狀態無關，先量好；拍一張全景，三張裁切都從這張全景切出，四張是同一瞬間。
      const clips = {
        "fleet-health": await visibleClip(page, ['section[aria-label="機群健康"]', '[data-fg="anomaly-summary"]']),
        "event-stream": await visibleClip(page, ['section[aria-label="事件流"]']),
        topology: await visibleClip(page, ['[data-fg="stage-topology"]']),
      };
      const { shot: full, ok: both } = await captureWhile(
        page,
        [
          { id: README_MACHINE, state: "critical" },
          { id: README_WARNING_MACHINE, state: "warning" },
        ],
        STATES_WAIT_MS,
      );
      shots.write("monitoring-states", full, both ? undefined : "未拍到嚴重與警告同屏");
      const crops = await cropShot(context, README_DESKTOP, full, clips);
      for (const [name, buffer] of Object.entries(crops)) shots.write(name, buffer, "自 monitoring-states 裁切");
    });

    await scene(shots, ["monitoring-search"], async () => {
      const input = page.locator('input[aria-label="搜尋機台"]:visible').first();
      try {
        await input.fill(opts.search);
        await sleep(400);
        await page.mouse.move(0, 0);
        shots.write("monitoring-search", await page.screenshot(), `查詢「${opts.search}」`);
      } finally {
        await clearSearch(page, input, "input");
        await sleep(300);
      }
    });

    await scene(shots, ["monitoring-selected"], async () => {
      // 先選取、面板展開落定，再等嚴重尖峰出現當下拍（尖峰約 1.45 秒，選取與展開的延遲會錯過）。
      await cardOf(page, README_MACHINE).click({ position: { x: 12, y: 12 } });
      await sleep(500);
      await ensureCopilotOpen(page, "1440x900");
      const { shot, ok } = await captureWhile(page, [{ id: README_MACHINE, state: "critical" }], SPIKE_WAIT_MS);
      shots.write("monitoring-selected", shot, ok ? undefined : `${README_MACHINE} 選取時不是嚴重`);
    });

    await scene(shots, ["copilot-streaming", "copilot-completed"], async () => {
      await waitForRecovery(page, README_MACHINE);
      const result = await runDiagnosis(page, { streaming: true });
      const problem = diagnosisProblem(result);
      if (problem) throw new Error(problem);
      if (result.cached) {
        const reason = "第一次診斷就命中快取，拍不到串流——先執行 ./scripts/demo-reset.ps1 清 ai-cache 再重拍";
        shots.miss("copilot-streaming", reason);
        shots.miss("copilot-completed", reason);
        return;
      }
      if (result.streamingShot) shots.write("copilot-streaming", result.streamingShot, `骨架已填 ${SKELETON_TARGET_FIELDS} 欄內`);
      else shots.miss("copilot-streaming", "串流太快，沒拍到骨架填入中途（可改用 fake provider 並調高 FAKE_AI_TOKEN_DELAY_MS）");
      await sleep(600);
      await shoot("copilot-completed");
    });

    await scene(shots, ["copilot-cached"], async () => {
      // 再診斷前同樣等一次回到正常；簽章若仍不同（最近錯誤類型變了）會再打一次 LLM，此時再試一次。
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await waitForRecovery(page, README_MACHINE);
        const result = await runDiagnosis(page);
        const problem = diagnosisProblem(result);
        if (problem) throw new Error(problem);
        if (result.cached) {
          await sleep(400);
          await shoot("copilot-cached");
          return;
        }
        log(`copilot-cached 第 ${attempt} 次未命中快取（快取簽章與前一次不同）`);
      }
      throw new Error("連續兩次未命中快取");
    });

    await scene(shots, ["dark-theme"], async () => {
      // 深色全景與 copilot-cached 同一畫面（README 第 14 節依此說明）；快取那張沒拍到時面板狀態不對，不拍。
      if (shots.results.get("copilot-cached").status !== "written") throw new Error("copilot-cached 未拍到，深色全景沿用舊檔");
      try {
        await applyTheme(page, "dark");
        await shoot("dark-theme");
      } finally {
        await applyTheme(page, "light");
      }
    });

    await scene(shots, ["copilot-failed"], async () => {
      // 攔截這一頁的 POST /diagnoses 回 503（不打到 api），重現「診斷佇列暫時無法使用」的可讀錯誤與「重試」。
      const pattern = "**/diagnoses";
      await page.route(pattern, (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ statusCode: 503, error: "Service Unavailable" }),
            })
          : route.continue(),
      );
      try {
        const result = await runDiagnosis(page);
        if (result.status !== "failed") throw new Error(`預期失敗，實際為 ${result.status || "未知"}`);
        await sleep(400);
        await shoot("copilot-failed", {}, "POST /diagnoses 以 route 攔截回 503");
      } finally {
        await page.unroute(pattern);
      }
    });
  } finally {
    await context.close();
  }
}

/**
 * 斷線重連：以 routeWebSocket 代理 /ws（其餘照常轉發），press-02 嚴重時切斷現有連線並拒絕之後的重連，
 * 等全部卡片顯示「停滯」再拍。不必關掉 api，dev server 與其他分頁的連線不受影響。
 */
async function shootReconnecting(browser, opts, shots) {
  const gate = { blocked: false, open: [] };
  const route = (page) =>
    page.routeWebSocket(WS_ROUTE, (ws) => {
      if (gate.blocked) {
        ws.close(SIMULATED_CLOSE).catch(() => {});
        return;
      }
      gate.open.push({ ws, server: ws.connectToServer() });
    });
  const { context, page } = await openReadmePage(browser, README_DESKTOP, opts, "reconnecting", route);
  try {
    await scene(shots, ["monitoring-reconnecting-stale"], async () => {
      if (gate.open.length === 0) throw new Error("routeWebSocket 沒有攔到 /ws 連線");
      // 斷線前讓嚴重底色過渡完，停格的就是完整的嚴重態
      const critical = (await waitFresh(page, [{ id: README_MACHINE, state: "critical" }], SPIKE_WAIT_MS)) !== null;
      gate.blocked = true;
      for (const { ws, server } of gate.open.splice(0)) {
        await server.close(SIMULATED_CLOSE).catch(() => {});
        await ws.close(SIMULATED_CLOSE).catch(() => {});
      }
      const cards = page.locator(".machine-card");
      const allStale = await pollUntil(
        async () => {
          const total = await cards.count();
          return total > 0 && (await page.locator(".machine-card", { hasText: "停滯" }).count()) === total;
        },
        STALE_WAIT_MS,
        500,
      );
      const notes = [];
      if (!critical) notes.push(`${README_MACHINE} 斷線時不是嚴重`);
      if (!allStale) notes.push(`${STALE_WAIT_MS}ms 內未全部停滯`);
      shots.write("monitoring-reconnecting-stale", await capture(page), notes.join("；") || undefined);
    });
  } finally {
    await context.close();
  }
}

/** 手機 390×844：選取 press-02 開 bottom-sheet，診斷完成後拍（多半命中桌機劇本留下的快取）。 */
async function shootMobile(browser, opts, shots) {
  const { context, page } = await openReadmePage(browser, README_MOBILE, opts, "390x844");
  try {
    await scene(shots, ["responsive-mobile"], async () => {
      const card = cardOf(page, README_MACHINE);
      await card.scrollIntoViewIfNeeded();
      await card.click({ position: { x: 12, y: 12 } });
      await sleep(500);
      await ensureCopilotOpen(page, "390x844");
      await waitForRecovery(page, README_MACHINE);
      const result = await runDiagnosis(page);
      const problem = diagnosisProblem(result);
      if (problem) throw new Error(problem);
      await sleep(600);
      shots.write("responsive-mobile", await capture(page), result.cached ? "快取命中" : "未命中快取");
    });
  } finally {
    await context.close();
  }
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

async function runReadme(opts) {
  const executablePath = findChromium();
  await checkServer(opts.url);

  const { chromium } = require("playwright-core");
  fs.mkdirSync(opts.out, { recursive: true });
  log(`瀏覽器：${executablePath}`);
  log(`目標：${opts.url} → 輸出：${opts.out}`);
  log("提醒：worker 需有效 GEMINI_API_KEY；先執行 ./scripts/demo-reset.ps1 清 AI 快取，才拍得到串流");

  const shots = createShotLog(opts.out);
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    // 順序有依賴：手機劇本排最後，才能命中桌機劇本留下的快取、不多打一次 LLM。
    // 每段各自包進 scene（合併門第 2 輪 low）：openReadmePage 在各段的 try 之外，一段載入失敗（goto 逾時、
    // 卡片沒出現）時只把該段負責的截圖記為缺漏，續跑下一段，最後照樣印缺漏總表。
    const solo = ["monitoring-reconnecting-stale", "responsive-mobile"];
    const segments = [
      { label: "1440x900", run: shootDesktop, names: README_SHOTS.filter((name) => !solo.includes(name)) },
      { label: "reconnecting", run: shootReconnecting, names: ["monitoring-reconnecting-stale"] },
      { label: "390x844", run: shootMobile, names: ["responsive-mobile"] },
    ];
    for (const segment of segments) {
      await scene(shots, segment.names, async () => {
        try {
          await segment.run(browser, opts, shots);
        } catch (err) {
          // scene 只取訊息第一行，這裡只加上段名
          throw new Error(`${segment.label} 劇本中止：${err && err.message ? err.message : String(err)}`);
        }
      });
    }
  } finally {
    await browser.close();
  }

  console.log("");
  const missing = [];
  for (const [name, r] of shots.results) {
    const mark = r.status === "written" ? "✓" : "✗";
    const detail = r.status === "written" ? r.note || "" : r.reason;
    console.log(`${mark} ${`${name}.png`.padEnd(36)}${detail}`);
    if (r.status !== "written") missing.push(name);
  }
  console.log("");
  if (missing.length > 0) {
    log(`SC-012：${README_SHOTS.length - missing.length}／${README_SHOTS.length} 張；缺 ${missing.join("、")}（未寫檔，舊檔保留）`);
    if (opts.fail) process.exitCode = 1;
  } else {
    log(`SC-012：${README_SHOTS.length} 張全部寫入 ${opts.out}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  switch (opts.mode) {
    case "--viewports":
      await runViewports(opts);
      return;
    case "--readme":
      await runReadme(opts);
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
