import { WebSocket } from "ws";
import { isConnectedMessage } from "./lib/health-probe.js";

/**
 * api 健康探針（映像第二進入點 → dist/healthcheck.js；FR-011、008 research D6、contracts §5）。
 *
 * 以原生 ws 連 `/ws`，收到 Gateway 無條件送出的 `system/connected` 即 exit 0（healthy），
 * 逾時／連線錯誤 exit 1（unhealthy）。探 HTTP 埠只能證明「行程在聽」，證明不了 Gateway 已
 * attach（api 無任何 GET 路由，探 HTTP 必得 404）——握手證明的才是 demo 所需的真實能力。
 *
 * 不需持有 token：`system/connected` 於連線當下無條件送出，WS_AUTH_SECRET 只在 machine/subscribe
 * 時檢查（health-probe.ts 的 rationale）。以 127.0.0.1 連自身容器，compose healthcheck 的
 * timeout 5s 為外層上限，本檔另設較短的自我逾時避免 socket 懸置。
 */
const port = Number(process.env.API_PORT ?? 3000);
const url = `ws://127.0.0.1:${port}/ws`;
const SELF_TIMEOUT_MS = 4000;

const socket = new WebSocket(url);

const done = (code: number): void => {
  try {
    socket.terminate();
  } catch {
    // 關閉本就要退出的探針 socket 若拋錯，無關健康判定
  }
  process.exit(code);
};

const timer = setTimeout(() => done(1), SELF_TIMEOUT_MS);
timer.unref?.();

socket.on("message", (raw: Buffer) => {
  if (isConnectedMessage(raw.toString())) {
    clearTimeout(timer);
    done(0);
  }
});
socket.on("error", () => {
  clearTimeout(timer);
  done(1);
});
