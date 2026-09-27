import { compose, listContainers, PROJECT } from "./compose.js";

/**
 * e2e 全域生命週期：起一組乾淨的全棧（build → up --wait），所有場景跑完後 `down -v`。
 *
 * - 起之前一律先 `down -v`（不論是否偵測到殘留容器）：上一輪若中途被中斷而殘留容器／volume，
 *   cache 與 job 會污染本輪（例如 happy path 直接命中上一輪的快取）。
 * - build 與 up 分開計時，輸出到終端供回報。
 * - `E2E_KEEP=1`：跑完不 down，方便事後 `docker compose -p flow-gatekeeper-e2e logs` 排查。
 * - 未設 E2E（非 `pnpm test:e2e`）時什麼都不做，測試檔本身也會 skip。
 */

const BUILD_TIMEOUT_MS = 20 * 60_000;
const UP_TIMEOUT_MS = 5 * 60_000;

function log(msg: string): void {
  console.log(`[e2e] ${msg}`);
}

async function down(): Promise<void> {
  await compose(["down", "-v", "--remove-orphans", "--timeout", "5"], { timeoutMs: 120_000 });
}

export async function setup(): Promise<void> {
  if (!process.env.E2E) return;

  // 無條件 down -v：容器已移除、volume 仍在時（例如 E2E_KEEP 後手動 down 未加 -v），listContainers()
  // 看不到殘留，redis（appendonly）的舊診斷 cache 卻會讓場景 1 直接命中 cache。
  const leftovers = (await listContainers()).length;
  log(leftovers > 0 ? `偵測到 ${PROJECT} 殘留容器，先 down -v 清掉` : `先 down -v 清掉 ${PROJECT} 可能殘留的 volume`);
  await down();

  log("build 映像（worker／api／web，標記 :e2e）…");
  const build = await compose(["build"], { inherit: true, timeoutMs: BUILD_TIMEOUT_MS });
  log(`build 完成：${(build.ms / 1000).toFixed(1)}s`);

  log("up -d --wait（等所有 healthcheck 轉 healthy）…");
  try {
    const up = await compose(["up", "-d", "--wait", "--wait-timeout", "240"], { timeoutMs: UP_TIMEOUT_MS });
    log(`全棧就緒：${(up.ms / 1000).toFixed(1)}s`);
  } catch (err) {
    const logs = await compose(["logs", "--no-color", "--tail", "80"]).catch(() => null);
    if (logs) console.error(logs.stdout);
    if (!process.env.E2E_KEEP) await down().catch(() => undefined);
    throw err;
  }
}

export async function teardown(): Promise<void> {
  if (!process.env.E2E) return;
  if (process.env.E2E_KEEP) {
    log(`E2E_KEEP 已設，保留 ${PROJECT} 容器（手動清理：docker compose -p ${PROJECT} down -v）`);
    return;
  }
  const t = Date.now();
  await down();
  log(`down -v 完成：${((Date.now() - t) / 1000).toFixed(1)}s`);
}
