import { onUnmounted, ref, type Ref } from "vue";
import type { ClientControlMessage, TelemetryPoint } from "@flow-gatekeeper/contracts";
import type { ConnectionStatus } from "../stores/monitoring.store.js";
import { nextBackoffDelay } from "../lib/backoff.js";

/**
 * 高頻 WebSocket composable：connect + buffer + rAF pump + 分流 + 心跳 + 指數退避重連 + 清理。
 *
 * 憲章 IV 核心：`onmessage` 只把遙測 push 進**非 reactive** buffer；一支 rAF 迴圈每幀
 * `buffer.splice(0)` 後透過 `onBatch` 一次交給 store，使 reactive 提交次數遠少於訊息數。
 * 控制訊息 MUST NOT 混入 telemetry buffer（分流處理）。
 *
 * 韌性（US3）：ping/pong 心跳（pong 逾時→close），onclose 非 manualClose→指數退避重連，
 * onerror→close；每次（重）連線的 `system/connected` 皆觸發 `onConnected`，使 App 重訂閱。
 */
export interface UseHighFrequencyWsOptions {
  /** 同源 `/ws`（dev 由 Vite proxy 轉發到 :3000）。 */
  url: string;
  /** 每幀批次回呼——交給 store.applyTelemetryBatch。 */
  onBatch: (batch: TelemetryPoint[]) => void;
  /** 連線三態回報——交給 store.setConnectionStatus。 */
  onStatus: (status: ConnectionStatus) => void;
  /** 收到 system/connected 時回呼（保存 clientId、隨即訂閱）；每次（重）連線都會觸發。 */
  onConnected: (clientId: string) => void;
  /** buffer 上限，超過丟最舊保最新（背景分頁 rAF 暫停時護記憶體）。 */
  maxBufferSize?: number;
  /** 心跳週期（ms），預設 15000。 */
  heartbeatMs?: number;
  /** pong 逾時（ms），逾時未回即 close 觸發重連，預設 5000。 */
  pongTimeoutMs?: number;
}

export interface HighFrequencyWsHandle {
  clientId: Ref<string | null>;
  send: (message: ClientControlMessage) => void;
  close: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function useHighFrequencyWs(
  options: UseHighFrequencyWsOptions,
): HighFrequencyWsHandle {
  const { url, onBatch, onStatus, onConnected } = options;
  const maxBufferSize = options.maxBufferSize ?? 2000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const pongTimeoutMs = options.pongTimeoutMs ?? 5_000;

  const clientId = ref<string | null>(null);

  // 非 reactive buffer：高頻 push 不觸發任何 reactive 更新（憲章 IV）。
  let buffer: TelemetryPoint[] = [];
  let rafId: number | null = null;
  let ws: WebSocket | null = null;

  let manualClose = false;
  let attempt = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** rAF pump：每幀把整批 buffer 一次交給 onBatch（=一次批次）。跨重連持續運作。 */
  function pump(): void {
    if (buffer.length > 0) {
      const batch = buffer.splice(0);
      onBatch(batch);
    }
    rafId = requestAnimationFrame(pump);
  }

  function clearPongTimer(): void {
    if (pongTimer !== null) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }
  }

  function clearHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    clearPongTimer();
  }

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /** 週期送 ping；每次 ping 起 pongTimer，逾時未收 pong 即 close 觸發重連。 */
  function startHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      send({ type: "ping" });
      clearPongTimer();
      pongTimer = setTimeout(() => {
        ws?.close(); // 逾時未回 pong → close → onclose → 重連
      }, pongTimeoutMs);
    }, heartbeatMs);
  }

  function scheduleReconnect(): void {
    if (manualClose) return;
    onStatus("reconnecting");
    const delay = nextBackoffDelay(attempt);
    attempt += 1;
    clearReconnect();
    reconnectTimer = setTimeout(connect, delay);
  }

  function handleMessage(event: MessageEvent): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      return; // 非 JSON 忽略
    }

    // 遙測批次：陣列 → 逐筆進 buffer（不逐筆寫 reactive state）。
    if (Array.isArray(parsed)) {
      for (const point of parsed as TelemetryPoint[]) {
        buffer.push(point);
      }
      if (buffer.length > maxBufferSize) {
        buffer.splice(0, buffer.length - maxBufferSize); // 丟最舊保最新
      }
      return;
    }

    if (!isRecord(parsed)) return;

    // 控制訊息分流（憲章 IV：MUST NOT 混入 telemetry buffer）。
    switch (parsed.type) {
      case "system/connected":
        // 每次（重）連線都觸發，讓 App 重新訂閱（FR-025）。
        if (typeof parsed.clientId === "string") {
          clientId.value = parsed.clientId;
          onConnected(parsed.clientId);
        }
        break;
      case "pong":
        clearPongTimer(); // 心跳確認
        break;
      // 訂閱回執／未授權：忽略。
      case "machine/subscribed":
      case "system/unauthorized":
        break;
      // ai/*、job/status 屬 005，本 feature 不消費。
      default:
        break;
    }
  }

  function connect(): void {
    ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      attempt = 0; // 連上重置退避
      onStatus("connected");
      startHeartbeat();
    });
    ws.addEventListener("message", handleMessage);
    ws.addEventListener("close", () => {
      clearHeartbeat();
      if (manualClose) {
        onStatus("disconnected");
      } else {
        scheduleReconnect(); // 非手動關閉 → 退避重連
      }
    });
    ws.addEventListener("error", () => {
      ws?.close(); // 交給 onclose 統一處理
    });
  }

  function send(message: ClientControlMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function close(): void {
    manualClose = true;
    clearHeartbeat();
    clearReconnect();
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    ws?.close();
    ws = null;
    buffer = [];
  }

  connect();
  rafId = requestAnimationFrame(pump);

  onUnmounted(close);

  return { clientId, send, close };
}
