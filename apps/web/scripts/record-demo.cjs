// flow-gatekeeper README demo 錄影劇本（2.0.0 release 前重錄；docs/20261018-demo-video）。
//
// 用法（於 repo 根目錄；需先起一鍵 demo 容器，並執行 ./scripts/demo-reset.ps1 清 AI 快取）：
//   node apps/web/scripts/record-demo.cjs --ffmpeg <ffmpeg.exe> [--url <url>] [--out <dir>] [--keep-frames]
//   ffmpeg 也可用環境變數 FFMPEG 指定；都沒給時用 PATH 上的 ffmpeg。需要含 libx264 的建置
//  （Playwright 自帶的 ffmpeg 只有 VP8，不能用）。
//
// 依 README「端到端操作 Demo」的 22 秒劇本，1440×900 一鏡到底、不剪接：
//   背壓 strip → 拓樸與 press-02 嚴重尖峰 → 搜尋「p」→ 清除、點選 press-02（面板自動展開）→ 診斷（Gemini 串流）
//   → 完成 → 「再次診斷」命中快取（耗時對比橫條）。
// 時間軸對齊 press-02 的尖峰週期（mock 每 240 tick ≈ 12 秒一次、持續約 1.45 秒）：開錄前先等一次尖峰開始，
// 讓下一次尖峰落在鏡頭第 3 秒左右；兩次診斷都在 press-02 回到正常滿 HISTORY_FLUSH_MS 之後送出，
// 快取簽章（含最近一筆 state）才相同、第二次才命中快取。
//
// 錄影方式：CDP Page.startScreencast 逐格取 JPEG（附時間戳），結束後依時間戳以 ffmpeg concat 轉成 30fps H.264 mp4；
// 比 Playwright recordVideo（即時 VP8、低位元率）清楚得多。headless 沒有游標，劇本以 addInitScript 注入假游標
//（只存在於錄影頁面，不動產品程式碼），滑鼠以緩動分段移動。
// 輸出：<out>/flow-gatekeeper-demo.mp4 與 <out>/flow-gatekeeper-demo-poster.jpg（取快取命中後的最後一格）。
// 第一次診斷就命中快取、或第二次沒命中快取時中止且不寫檔（先 demo-reset 再重錄），不自動重試，避免多打 LLM。

/* global document, window, performance, MutationObserver */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DEFAULT_URL = "http://localhost:8080/";
const DEFAULT_OUT = path.resolve(__dirname, "..", "..", "..", "docs", "demo");
const VIEWPORT = { width: 1440, height: 900 };
const MACHINE = "press-02";
const SEARCH = "p";
const FPS = 30;
const WARMUP_MS = 20000; // 開錄前至少載入 20 秒，讓近 60 秒走勢線有內容
const SPIKE_AT_MS = 2000; // 下一次尖峰在鏡頭第幾毫秒出現
const SPIKE_WAIT_MS = 30000;
// 尖峰週期名目 12 秒，但容器裡計時器會漂（實測約 13.5 秒），開錄前量兩次尖峰取實際值；超出此範圍視為量錯、用名目值。
const SPIKE_PERIOD = { nominal: 12000, min: 9000, max: 18000 };
const HISTORY_FLUSH_MS = 2200; // api 每 1 秒 flush 遙測；回到正常後多等一輪，worker 讀到的最近 state 才是 healthy
const REDIAGNOSE_AT_MS = 18500; // 劇本表 0:19 再診斷
const DIAGNOSIS_TIMEOUT_MS = 60000;
const END_HOLD_MS = 2500;

class UserError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[record-demo] ${message}`);

function parseArgs(argv) {
  const opts = { url: DEFAULT_URL, out: DEFAULT_OUT, ffmpeg: process.env.FFMPEG || "ffmpeg", keepFrames: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UserError(`${arg} 缺少參數值`);
      i += 1;
      return argv[i];
    };
    if (arg === "--url") opts.url = value();
    else if (arg === "--out") opts.out = path.resolve(value());
    else if (arg === "--ffmpeg") opts.ffmpeg = value();
    else if (arg === "--keep-frames") opts.keepFrames = true;
    else throw new UserError(`不認得的參數：${arg}`);
  }
  return opts;
}

/** PLAYWRIGHT_CHROMIUM，否則 ms-playwright 目錄下最新的 chromium_headless_shell-*（同 screenshots.cjs）。 */
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ms-playwright");
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .map((entry) => /^chromium_headless_shell-(\d+)$/.exec(entry.name))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const match of dirs) {
    const exe = path.join(root, match[0], "chrome-headless-shell-win64", "chrome-headless-shell.exe");
    if (fs.existsSync(exe)) return exe;
  }
  throw new UserError("找不到 chromium_headless_shell；請設 PLAYWRIGHT_CHROMIUM 或安裝 Playwright Chromium");
}

function checkFfmpeg(ffmpeg) {
  let encoders;
  try {
    encoders = execFileSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    throw new UserError(`無法執行 ffmpeg：${ffmpeg}（用 --ffmpeg 或環境變數 FFMPEG 指定）`);
  }
  if (!encoders.includes("libx264")) throw new UserError(`${ffmpeg} 沒有 libx264 編碼器（Playwright 自帶的 ffmpeg 只有 VP8）`);
}

// ---------- 假游標 ----------

/**
 * 錄影頁面專用的游標圖層：跟著 mousemove 走，按下時縮一下並畫一圈擴散環。
 * 頁面 CSP 為 style-src 'self'，注入 <style> 會被擋；樣式一律走 CSSOM（element.style）、動畫走 Web Animations API。
 */
function installFakeCursor() {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const mount = () => {
    if (document.getElementById("__demo-cursor")) return;
    const cursor = document.createElement("div");
    cursor.id = "__demo-cursor";
    Object.assign(cursor.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "22px",
      height: "22px",
      zIndex: "2147483647",
      pointerEvents: "none",
      transform: "translate(-100px, -100px)",
    });
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "22");
    svg.setAttribute("height", "22");
    svg.setAttribute("viewBox", "0 0 22 22");
    svg.style.display = "block";
    svg.style.transformOrigin = "3px 2px";
    const arrow = document.createElementNS(SVG_NS, "path");
    arrow.setAttribute("d", "M3 2 L3 18 L7.2 14.2 L10 20.5 L12.8 19.3 L10.1 13.2 L16 13.2 Z");
    arrow.setAttribute("fill", "#ffffff");
    arrow.setAttribute("stroke", "#14181f");
    arrow.setAttribute("stroke-width", "1.4");
    arrow.setAttribute("stroke-linejoin", "round");
    svg.appendChild(arrow);
    cursor.appendChild(svg);
    document.body.appendChild(cursor);
    window.addEventListener(
      "mousemove",
      (e) => {
        cursor.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`;
      },
      true,
    );
    window.addEventListener(
      "mousedown",
      (e) => {
        svg.animate([{ transform: "scale(1)" }, { transform: "scale(0.82)" }], { duration: 90, fill: "forwards" });
        const ring = document.createElement("div");
        Object.assign(ring.style, {
          position: "fixed",
          left: `${e.clientX - 14}px`,
          top: `${e.clientY - 14}px`,
          width: "28px",
          height: "28px",
          boxSizing: "border-box",
          border: "2px solid rgba(20, 24, 31, 0.55)",
          borderRadius: "50%",
          zIndex: "2147483646",
          pointerEvents: "none",
        });
        document.body.appendChild(ring);
        ring
          .animate(
            [
              { transform: "scale(0.4)", opacity: 1 },
              { transform: "scale(1.5)", opacity: 0 },
            ],
            { duration: 420, easing: "ease-out", fill: "forwards" },
          )
          .finished.then(() => ring.remove());
      },
      true,
    );
    window.addEventListener(
      "mouseup",
      () => svg.animate([{ transform: "scale(0.82)" }, { transform: "scale(1)" }], { duration: 90, fill: "forwards" }),
      true,
    );
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
}

function createPointer(page, start) {
  const pos = { ...start };
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  return {
    async glide(x, y, ms = 650) {
      // 依經過時間算進度（不是固定步數）：每次 mouse.move 都有往返延遲，固定步數會比 ms 慢上一截、擠掉後面的停留。
      const from = { ...pos };
      const start = Date.now();
      for (;;) {
        const p = Math.min(1, (Date.now() - start) / ms);
        const k = ease(p);
        await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
        if (p >= 1) break;
        await sleep(16);
      }
      pos.x = x;
      pos.y = y;
    },
    async glideTo(locator, { dx = 0.5, dy = 0.5, ms } = {}) {
      const box = await locator.boundingBox();
      if (!box) throw new Error("目標不可見，無法移動游標");
      await this.glide(box.x + box.width * dx, box.y + box.height * dy, ms);
    },
    async click(locator, options) {
      await this.glideTo(locator, options);
      await sleep(120);
      await page.mouse.down();
      await sleep(90);
      await page.mouse.up();
    },
  };
}

// ---------- 逐格擷取 ----------

async function startScreencast(page, dir) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let latest = null;
  // 時間戳用 node 端收到該格的時刻：CDP metadata.timestamp 與劇本排程的時鐘實測差 2～3 秒，影片會與排程錯開。
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    const wall = Date.now();
    const file = path.join(dir, `f${String(frames.length).padStart(6, "0")}.jpg`);
    const buffer = Buffer.from(data, "base64");
    fs.writeFileSync(file, buffer);
    frames.push({ file, t: wall / 1000, wall });
    latest = buffer;
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 92,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  });
  return {
    frames,
    latest: () => latest,
    async stop() {
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
    },
  };
}

/** 依各格時間戳寫 concat 清單（每格停留到下一格為止），轉成固定 FPS 的 H.264。 */
function encode(ffmpeg, frames, endTime, dir, outFile) {
  if (frames.length < 2) throw new Error(`只擷取到 ${frames.length} 格，無法輸出影片`);
  const lines = [];
  frames.forEach((frame, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : endTime;
    lines.push(`file '${frame.file.replace(/\\/g, "/")}'`, `duration ${Math.max(0.001, next - frame.t).toFixed(4)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file.replace(/\\/g, "/")}'`); // concat demuxer 需重複最後一格
  const list = path.join(dir, "frames.txt");
  fs.writeFileSync(list, `${lines.join("\n")}\n`);
  execFileSync(
    ffmpeg,
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", list,
      // JPEG 是 full range；轉成 limited range，QuickTime 等播放器顏色才不會發灰。
      "-vf", `fps=${FPS},scale=in_range=full:out_range=limited,format=yuv420p`,
      "-color_range", "tv",
      "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-tune", "stillimage",
      "-movflags", "+faststart",
      outFile,
    ],
    { stdio: "inherit" },
  );
}

// ---------- 劇本 ----------

const cardOf = (page, id) => page.locator(`.machine-card[data-machine="${id}"]`).first();

/** 記錄每台機器最近一次 data-state 變化的頁面時鐘。 */
async function installStateClock(page) {
  await page.evaluate(() => {
    window.__demoLastChange = {};
    new MutationObserver((records) => {
      const t = performance.now();
      for (const r of records) {
        const id = r.target.getAttribute && r.target.getAttribute("data-machine");
        if (id) window.__demoLastChange[id] = t;
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
  });
}

/** 等 id 的卡片從非 state 變成 state（尖峰開始），回傳成立時的 Date.now()；逾時回 null。 */
async function waitSpikeStart(page, id, state, timeoutMs) {
  const ok = await page.evaluate(
    ({ id: machine, state: want, limit }) =>
      new Promise((resolve) => {
        const el = () => document.querySelector(`.machine-card[data-machine="${machine}"]`);
        let armed = !(el() && el().getAttribute("data-state") === want);
        const deadline = performance.now() + limit;
        const tick = () => {
          const holds = el() && el().getAttribute("data-state") === want;
          if (!holds) armed = true;
          else if (armed) return resolve(true);
          if (performance.now() > deadline) return resolve(false);
          window.requestAnimationFrame(tick);
        };
        tick();
      }),
    { id, state, limit: timeoutMs },
  );
  return ok ? Date.now() : null;
}

/** id 目前正常、且距最近一次狀態變化已滿 HISTORY_FLUSH_MS（worker 讀到的最近 state 才會是 healthy）。 */
async function settledHealthy(page, id) {
  return page.evaluate(
    ({ machine, flush }) => {
      const el = document.querySelector(`.machine-card[data-machine="${machine}"]`);
      if (!el || el.getAttribute("data-state") !== "healthy") return false;
      const last = window.__demoLastChange[machine];
      return last === undefined || performance.now() - last >= flush;
    },
    { machine: id, flush: HISTORY_FLUSH_MS },
  );
}

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`等不到${label}`);
    await sleep(50);
  }
}

/** AI 診斷面板的狀態 chip 與完成 meta 是否為快取（同 screenshots.cjs panelSnapshot 的精簡版）。 */
async function panelStatus(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-fg="copilot"]');
    const header = panel && panel.querySelector("header");
    if (!header) return { status: null, job: null, cached: null };
    const map = { 未診斷: "idle", 進行中: "active", 已完成: "completed", 失敗: "failed" };
    const chip = Array.from(header.querySelectorAll("span"))
      .map((el) => el.textContent.trim())
      .find((text) => text in map);
    const job = header.querySelector(".font-mono");
    const timing = panel.querySelector('[data-fg="timing"]');
    return {
      status: chip ? map[chip] : null,
      job: job ? job.textContent.trim() : null,
      cached: timing ? timing.getAttribute("data-cached") === "true" : null,
    };
  });
}

async function waitDiagnosisDone(page, beforeJob) {
  let done = null;
  await waitUntil(
    async () => {
      const snap = await panelStatus(page);
      if (snap.job !== beforeJob && (snap.status === "completed" || snap.status === "failed")) done = snap;
      return done !== null;
    },
    DIAGNOSIS_TIMEOUT_MS,
    "診斷完成",
  );
  if (done.status === "failed") throw new Error("診斷失敗（AI 診斷面板顯示「失敗」）");
  return done;
}

async function perform(page, pointer, t0) {
  const at = (ms) => sleep(Math.max(0, t0 + ms - Date.now()));
  const card = cardOf(page, MACHINE);

  // 0:00–0:02 鏡頭 1：背壓 strip（合併比與液柱）
  await at(500);
  await pointer.glideTo(page.locator('[data-fg="ratio"]:visible').first(), { dx: 0.5, dy: 1.6, ms: 900 });

  // 0:02–0:04 拓樸：press-02 嚴重尖峰
  await at(1700);
  await pointer.glideTo(page.locator('[data-fg="stage-topology"]').first(), { dx: 0.5, dy: 0.08, ms: 500 });
  await pointer.glideTo(card, { dx: 0.82, dy: 0.5, ms: 500 });

  // 0:04–0:06 搜尋「p」：只留命中卡片、欄位不變
  await at(3500);
  const search = page.locator('input[aria-label="搜尋機台"]:visible').first();
  await pointer.click(search, { dx: 0.3, ms: 600 });
  await page.keyboard.type(SEARCH, { delay: 120 });
  await at(5900);
  await page.keyboard.press("Backspace");
  await sleep(250);

  // 0:06–0:07 點選 press-02（面板自動展開）→ 按面板內「診斷」
  await pointer.click(card, { dx: 0.3, dy: 0.18, ms: 650 });
  await sleep(700);
  const diagnose = page.locator('[data-fg="copilot"] button:visible', { hasText: /^\s*診斷\s*$/ }).first();
  await waitUntil(() => settledHealthy(page, MACHINE), SPIKE_WAIT_MS, `${MACHINE} 回到正常`);
  const before = await panelStatus(page);
  await pointer.click(diagnose, { ms: 600 });

  // 0:08–0:16 鏡頭 2：串流骨架逐格填入 → 完成
  await sleep(400);
  const skeleton = page.locator('[data-fg="copilot"] [data-fg="result-skeleton"]').first();
  await skeleton.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  if (await skeleton.isVisible()) await pointer.glideTo(skeleton, { dx: 0.92, dy: 0.12, ms: 800 });
  const first = await waitDiagnosisDone(page, before.job);
  if (first.cached) throw new Error("第一次診斷就命中快取，看不到串流——先執行 ./scripts/demo-reset.ps1 再重錄");
  log(`第一次診斷完成（非快取），鏡頭 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

  // 0:19–0:22 鏡頭 3：「再次診斷」命中快取（耗時對比橫條）
  const again = page.locator('[data-fg="copilot"] button:visible', { hasText: "再次診斷" }).first();
  await at(REDIAGNOSE_AT_MS - 1200);
  await pointer.glideTo(again, { ms: 700 });
  await at(REDIAGNOSE_AT_MS);
  await waitUntil(() => settledHealthy(page, MACHINE), SPIKE_WAIT_MS, `${MACHINE} 回到正常`);
  await pointer.click(again, { ms: 150 });
  const second = await waitDiagnosisDone(page, first.job);
  if (!second.cached) throw new Error("再次診斷沒有命中快取（快取簽章與第一次不同）——demo-reset 後重錄");
  log(`再次診斷命中快取，鏡頭 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  const timing = page.locator('[data-fg="copilot"] [data-fg="timing"]').first();
  await sleep(300);
  if (await timing.isVisible()) await pointer.glideTo(timing, { dx: 0.96, dy: 1.2, ms: 700 });
  await sleep(END_HOLD_MS);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  checkFfmpeg(opts.ffmpeg);
  const executablePath = findChromium();
  const { chromium } = require("playwright-core");
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), "fg-demo-frames-"));
  fs.mkdirSync(opts.out, { recursive: true });
  log(`瀏覽器：${executablePath}`);
  log(`目標：${opts.url} → 輸出：${opts.out}（逐格暫存：${framesDir}）`);

  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    context.setDefaultTimeout(10000);
    await context.addInitScript(installFakeCursor);
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") log(`console.error：${m.text().slice(0, 200)}`);
    });
    await page.goto(opts.url, { waitUntil: "networkidle" });
    await page.locator(".machine-card").first().waitFor({ state: "visible", timeout: 15000 });
    await installStateClock(page);
    const pointer = createPointer(page, { x: 1180, y: 560 });
    await page.mouse.move(1180, 560);

    const loadedAt = Date.now();
    log(`暖機至少 ${WARMUP_MS / 1000} 秒，量 ${MACHINE} 尖峰週期以對齊時間軸…`);
    const spikeStart = async () => {
      const at = await waitSpikeStart(page, MACHINE, "critical", SPIKE_WAIT_MS);
      if (at === null) throw new Error(`${SPIKE_WAIT_MS / 1000} 秒內沒等到 ${MACHINE} 的嚴重尖峰`);
      return at;
    };
    const s1 = await spikeStart();
    let spike = await spikeStart();
    const measured = spike - s1;
    const period = measured >= SPIKE_PERIOD.min && measured <= SPIKE_PERIOD.max ? measured : SPIKE_PERIOD.nominal;
    log(`尖峰週期實測 ${(measured / 1000).toFixed(2)} 秒${period === measured ? "" : `（超出範圍，改用 ${period / 1000} 秒）`}`);
    while (spike - loadedAt < WARMUP_MS) spike += period;
    const nextSpike = spike + period;
    await sleep(Math.max(0, nextSpike - SPIKE_AT_MS - Date.now()));

    const cast = await startScreencast(page, framesDir);
    await waitUntil(async () => cast.frames.length > 0, 10000, "第一格畫面");
    // 時間軸以第一格送達時刻為 0：startScreencast 的回應可能比第一格晚好幾秒。
    const t0 = cast.frames[0].wall;
    log(`開錄；預計尖峰在鏡頭 ${((nextSpike - t0) / 1000).toFixed(1)} 秒`);
    try {
      await perform(page, pointer, t0);
    } finally {
      await cast.stop();
    }
    const stoppedAt = Date.now();
    const frames = cast.frames;
    // 最後一格停留到停錄為止（畫面沒有重繪時不會再送格）。
    const endTime = stoppedAt / 1000;
    log(`擷取 ${frames.length} 格，長度約 ${((stoppedAt - t0) / 1000).toFixed(1)} 秒；編碼中…`);
    const video = path.join(opts.out, "flow-gatekeeper-demo.mp4");
    encode(opts.ffmpeg, frames, endTime, framesDir, video);
    fs.writeFileSync(path.join(opts.out, "flow-gatekeeper-demo-poster.jpg"), cast.latest());
    log(`寫入 ${video} 與海報`);
  } finally {
    await browser.close();
    if (opts.keepFrames) log(`保留逐格：${framesDir}`);
    else fs.rmSync(framesDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  if (err instanceof UserError) console.error(`[record-demo] 錯誤：${err.message}`);
  else console.error(`[record-demo] 錄影失敗：${err && err.message ? err.message.split("\n")[0] : String(err)}`);
  process.exit(1);
});
