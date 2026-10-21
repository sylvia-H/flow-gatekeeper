import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * docker compose 的薄包裝：所有 e2e 指令都帶同一組 `-p`／`-f`／`--profile`，
 * 讓容器、網路、volume 全部落在獨立專案 `flow-gatekeeper-e2e` 之下，不碰使用者的 demo／dev infra。
 */

export const PROJECT = "flow-gatekeeper-e2e";
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
/** web（nginx）對外入口；見 docker-compose.e2e.yml。 */
export const BASE_URL = "http://127.0.0.1:18080";
export const WS_URL = "ws://127.0.0.1:18080/ws";

const BASE_ARGS = [
  "compose",
  "-p",
  PROJECT,
  "--project-directory",
  REPO_ROOT,
  "-f",
  resolve(REPO_ROOT, "docker-compose.yml"),
  "-f",
  resolve(REPO_ROOT, "docker-compose.e2e.yml"),
  "--profile",
  "demo",
];

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

/**
 * 執行 `docker compose <args>`。`inherit=true` 時把輸出直接轉到終端（build 進度），
 * 否則收集起來回傳。非零退出一律 reject（附 stderr 尾段）。
 */
export function compose(args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return runDocker([...BASE_ARGS, ...args], `docker compose ${args.join(" ")}`, opts);
}

/** 執行不經 compose 的 `docker <args>`（例如 `docker inspect`）；錯誤處理同 `compose`。 */
export function docker(args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return runDocker(args, `docker ${args.join(" ")}`, opts);
}

export interface RunOptions {
  inherit?: boolean;
  timeoutMs?: number;
}

function runDocker(fullArgs: readonly string[], label: string, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  return new Promise<RunResult>((resolvePromise, reject) => {
    const child = spawn("docker", [...fullArgs], {
      cwd: REPO_ROOT,
      stdio: opts.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
      // 不讓 host shell 殘留的插值變數改變 e2e 拓樸（WEB_BIND 已由 override 釘死，這裡再保險一次）。
      env: { ...process.env, REDIS_PASSWORD: "", WEB_BIND: "127.0.0.1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill();
            reject(new Error(`${label} 逾時（${opts.timeoutMs}ms）`));
          }, opts.timeoutMs);
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result: RunResult = { code: code ?? -1, stdout, stderr, ms: Date.now() - started };
      if (result.code === 0) resolvePromise(result);
      else reject(new Error(`${label} 失敗（exit ${result.code}）：${stderr.slice(-2000)}`));
    });
  });
}

/** 列出本專案目前存在的容器 id（含已停止）。 */
export async function listContainers(): Promise<string[]> {
  const { stdout } = await compose(["ps", "-a", "-q"]);
  return stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
}

// ── 故障注入與服務生命週期（012 FR-046；plan「e2e harness 需要新增的 helper」）──────────────────────────

/** 凍結 redis 容器（SIGSTOP 等效的 cgroup freeze，連線不斷、指令不回）——場景 7。 */
export async function pauseRedis(): Promise<void> {
  await compose(["pause", "redis"], { timeoutMs: 30_000 });
}

export async function unpauseRedis(): Promise<void> {
  await compose(["unpause", "redis"], { timeoutMs: 30_000 });
}

/** 重啟 api 容器（SIGTERM → stop_grace_period 15s 內收尾 → 再起）；之後以 `waitHealthy("api")` 等到可服務。 */
export async function restartApi(): Promise<void> {
  await compose(["restart", "api"], { timeoutMs: 120_000 });
}

/** 停 worker（SIGTERM；容器停住、不被 restart policy 拉起，直到 `startWorker`）——場景 6b。 */
export async function stopWorker(): Promise<void> {
  // stop_grace_period 45s（docker-compose.yml），逾時上限再多留餘裕
  await compose(["stop", "worker"], { timeoutMs: 120_000 });
}

/** 啟動已停的 worker（同一容器，日誌延續）；要等到可接 job 時另以 `waitHealthy("worker")` 或 `workerReadyAt`。 */
export async function startWorker(): Promise<void> {
  await compose(["start", "worker"], { timeoutMs: 60_000 });
}

/** `docker compose ps --format json` 單一容器列中本 harness 用得到的欄位。 */
export interface PsEntry {
  service: string;
  state: string;
  /** `healthy`／`starting`／`unhealthy`；沒有 healthcheck 的服務為空字串。 */
  health: string;
}

/**
 * 解析 `docker compose ps --format json` 輸出：Compose 2.21+ 為一列一個 JSON 物件（NDJSON），更早的版本為單一
 * JSON 陣列，兩種都吃。無法解析的列略過（例如 compose 在 stdout 夾帶的提示行）。
 */
export function parseComposePs(stdout: string): PsEntry[] {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  const rows: unknown[] = [];
  if (trimmed.startsWith("[")) {
    try {
      const arr: unknown = JSON.parse(trimmed);
      if (Array.isArray(arr)) rows.push(...(arr as unknown[]));
    } catch {
      // 不是完整的 JSON 陣列：落到逐列解析
    }
  }
  if (rows.length === 0) {
    for (const line of trimmed.split(/\r?\n/)) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        // 非 JSON 列略過
      }
    }
  }
  return rows.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const r = row as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    return typeof r.Service === "string" ? [{ service: r.Service, state: str(r.State), health: str(r.Health) }] : [];
  });
}

/** 該服務的容器是否全部可服務：有 healthcheck 者須 `healthy`，沒有者須 `running`；沒有任何容器時為 false。 */
export function isServiceHealthy(entries: readonly PsEntry[], service: string): boolean {
  const mine = entries.filter((e) => e.service === service);
  return (
    mine.length > 0 &&
    mine.every((e) => e.state === "running" && (e.health === "healthy" || e.health === ""))
  );
}

/**
 * 輪詢 `compose ps --format json <service>`（每 1 s）直到該服務 healthy；逾時 reject 並附最後一次看到的狀態。
 * 回傳等待耗時（毫秒）。容器剛重啟、尚未列出或仍 `starting` 時都繼續等。
 */
export async function waitHealthy(service: string, timeoutMs: number): Promise<number> {
  const started = Date.now();
  let last = "（尚未取得狀態）";
  for (;;) {
    try {
      const { stdout } = await compose(["ps", "--format", "json", service], { timeoutMs: 15_000 });
      const entries = parseComposePs(stdout);
      if (isServiceHealthy(entries, service)) return Date.now() - started;
      last = entries.length === 0 ? "（無執行中的容器）" : entries.map((e) => `${e.state}/${e.health || "-"}`).join(", ");
    } catch (err) {
      // compose 偶發失敗（daemon 忙碌）不中止等待；保留訊息供逾時時呈現
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`等待 ${service} healthy 逾時（${timeoutMs}ms），最後狀態：${last}`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
