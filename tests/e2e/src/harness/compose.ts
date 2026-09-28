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
export function compose(args: readonly string[], opts: { inherit?: boolean; timeoutMs?: number } = {}): Promise<RunResult> {
  const started = Date.now();
  return new Promise<RunResult>((resolvePromise, reject) => {
    const child = spawn("docker", [...BASE_ARGS, ...args], {
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
            reject(new Error(`docker compose ${args.join(" ")} 逾時（${opts.timeoutMs}ms）`));
          }, opts.timeoutMs);
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result: RunResult = { code: code ?? -1, stdout, stderr, ms: Date.now() - started };
      if (result.code === 0) resolvePromise(result);
      else reject(new Error(`docker compose ${args.join(" ")} 失敗（exit ${result.code}）：${stderr.slice(-2000)}`));
    });
  });
}

/** 列出本專案目前存在的容器 id（含已停止）。 */
export async function listContainers(): Promise<string[]> {
  const { stdout } = await compose(["ps", "-a", "-q"]);
  return stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
}
