import { onUnmounted, ref, type Ref } from "vue";
import type { ClientControlMessage, TelemetryPoint } from "@flow-gatekeeper/contracts";
import type { ConnectionStatus } from "../stores/monitoring.store.js";

/**
 * 高頻 WebSocket composable（US1 版：connect + buffer + rAF pump + onmessage 分流 + 清理）。
 * 心跳／指數退避重連於 US3（T022）擴充於同檔。
 *
 * 憲章 IV 核心：`onmessage` 只把遙測 push 進**非 reactive** buffer；一支 rAF 迴圈每幀
 * `buffer.splice(0)` 後透過 `onBatch` 一次交給 store，使 reactive 提交次數遠少於訊息數。
 * 控制訊息 MUST NOT 混入 telemetry buffer（分流處理）。
 */
export interface UseHighFrequencyWsOptions {
  /** 同源 `/ws`（dev 由 Vite proxy 轉發到 :3000）。 */
  url: string;
  /** 每幀批次回呼——交給 store.applyTelemetryBatch。 */
  onBatch: (batch: TelemetryPoint[]) => void;
  /** 連線三態回報——交給 store.setConnectionStatus。 */
  onStatus: (status: ConnectionStatus) => void;
  /** 收到 system/connected 時回呼（保存 clientId、隨即訂閱）。 */
  onConnected: (clientId: string) => void;
  /** buffer 上限，超過丟最舊保最新（背景分頁 rAF 暫停時護記憶體）。 */
  maxBufferSize?: number;
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

  const clientId = ref<string | null>(null);

  // 非 reactive buffer：高頻 push 不觸發任何 reactive 更新（憲章 IV）。
  let buffer: TelemetryPoint[] = [];
  let rafId: number | null = null;
  let ws: WebSocket | null = null;

  /** rAF pump：每幀把整批 buffer 一次交給 onBatch（=一次批次）。 */
  function pump(): void {
    if (buffer.length > 0) {
      const batch = buffer.splice(0);
      onBatch(batch);
    }
    rafId = requestAnimationFrame(pump);
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
        if (typeof parsed.clientId === "string") {
          clientId.value = parsed.clientId;
          onConnected(parsed.clientId);
        }
        break;
      // pong（US3 心跳用）／訂閱回執／未授權：US1 先忽略。
      case "pong":
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
      onStatus("connected");
    });
    ws.addEventListener("message", handleMessage);
    ws.addEventListener("close", () => {
      // US1 尚無重連：僅回報 disconnected（重連於 US3 T022 接入）。
      onStatus("disconnected");
    });
    ws.addEventListener("error", () => {
      ws?.close();
    });
  }

  function send(message: ClientControlMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function close(): void {
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
