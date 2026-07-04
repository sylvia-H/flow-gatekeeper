import { onUnmounted, ref, type Ref } from "vue";
import type { ClientControlMessage, TelemetryPoint } from "@flow-gatekeeper/contracts";
import type { ConnectionStatus } from "../stores/monitoring.store.js";
import { nextBackoffDelay } from "../lib/backoff.js";
import { classifyWsMessage, type DiagnosisEvent } from "../lib/ws-message.js";

export type { DiagnosisEvent };

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
  /**
   * 選用：收到診斷事件（job/status／ai/token／ai/done／ai/error）時分流回呼（交 copilot.store）。
   * 憲章 IV／FR-017：診斷事件 MUST NOT 進遙測 buffer，直接分流不破壞遙測 rAF 批次。
   */
  onDiagnosisEvent?: (event: DiagnosisEvent) => void;
  /** 選用（US4）：pong 到達時回報 ping→pong RTT（ms）→ store.setLatency。 */
  onLatency?: (ms: number) => void;
  /**
   * 選用（US4）：pump 每幀讀它——回 true 時**跳過 flush、續存 buffer**（畫面凍結），
   * resume（回 false）後下一幀 flush 整個 buffer＝直接跳到最新（FR-013／research R6）。
   */
  isPaused?: () => boolean;
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

export function useHighFrequencyWs(
  options: UseHighFrequencyWsOptions,
): HighFrequencyWsHandle {
  const { url, onBatch, onStatus, onConnected, onDiagnosisEvent } = options;
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
  let lastPingAt = 0; // US4：最近一次送 ping 的時刻，供 pong 計 RTT。
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** rAF pump：每幀把整批 buffer 一次交給 onBatch（=一次批次）。跨重連持續運作。 */
  function pump(): void {
    // US4 pause：跳過 flush 但**保留 rAF 迴圈與 buffer 累積**（buffer 仍受 maxBufferSize 保護）。
    if (options.isPaused?.()) {
      rafId = requestAnimationFrame(pump);
      return;
    }
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
      lastPingAt = Date.now(); // US4：記發送時刻，pong 到達時計 RTT。
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

    // 分流由純函式 classifyWsMessage 決定（憲章 IV／FR-017 分流不變量可單元測試）。
    const routed = classifyWsMessage(parsed);
    switch (routed.kind) {
      case "telemetry":
        // 遙測批次：逐筆進**非 reactive** buffer（不逐筆寫 reactive state）。
        for (const point of routed.points) {
          buffer.push(point);
        }
        if (buffer.length > maxBufferSize) {
          buffer.splice(0, buffer.length - maxBufferSize); // 丟最舊保最新
        }
        return;
      case "diagnosis":
        // 診斷事件（005）：分流交 copilot.store，MUST NOT 進遙測 buffer（憲章 IV／FR-017）。
        onDiagnosisEvent?.(routed.event);
        return;
      case "control":
        handleControlMessage(routed.message);
        return;
      case "ignore":
        return;
    }
  }

  /** 控制訊息副作用（system/connected 保存 clientId 並重訂閱；pong 確認心跳）。 */
  function handleControlMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case "system/connected":
        // 每次（重）連線都觸發，讓 App 重新訂閱（FR-025）。
        if (typeof message.clientId === "string") {
          clientId.value = message.clientId;
          onConnected(message.clientId);
        }
        break;
      case "pong":
        if (lastPingAt > 0) options.onLatency?.(Date.now() - lastPingAt); // US4：回報 RTT
        clearPongTimer(); // 心跳確認
        break;
      // machine/subscribed／system/unauthorized：忽略。
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
