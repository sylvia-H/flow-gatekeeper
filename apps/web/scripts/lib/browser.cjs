// 截圖劇本（screenshots.cjs）與 demo 錄影劇本（record-demo.cjs）共用：Chromium 尋找、使用者錯誤型別、AI 診斷面板狀態 chip 對照。
// 兩支劇本都只用 playwright-core（不下載瀏覽器），尋找規則見 README「截圖劇本」。

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const INSTALL_HINT =
  "找不到可用的 Chromium。請執行 `pnpm --filter web exec playwright-core install chromium-headless-shell`，" +
  "或設定環境變數 PLAYWRIGHT_CHROMIUM 指向 chrome／chrome-headless-shell 可執行檔。";

/** 使用者可修正的錯誤（參數、環境）：只印訊息、不印堆疊。 */
class UserError extends Error {}

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

/**
 * AI 診斷面板標頭狀態 chip 的文案 → 狀態（在 page.evaluate 內使用，須以參數傳入）。
 * T073 起閒置 chip 為「未診斷」（sheet 閒置單列不顯示 chip，此時 status 為 null）；「閒置」保留給舊文案。
 */
const COPILOT_STATUS_CHIPS = Object.freeze({ 未診斷: "idle", 閒置: "idle", 進行中: "active", 已完成: "completed", 失敗: "failed" });

/** 某台機台的卡片（`.machine-card[data-machine]`）。 */
const cardOf = (page, id) => page.locator(`.machine-card[data-machine="${id}"]`).first();

module.exports = { COPILOT_STATUS_CHIPS, INSTALL_HINT, UserError, cardOf, findChromium, msPlaywrightDirs };
