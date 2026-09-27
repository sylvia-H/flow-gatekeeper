import { onScopeDispose } from "vue";
import type {
  ClientControlMessage,
  SystemMetrics,
  TelemetryPoint,
} from "@flow-gatekeeper/contracts";
import type { ConnectionStatus, DropCounts } from "../stores/monitoring.store.js";
import { nextBackoffDelay } from "../lib/backoff.js";
import { classifyWsMessage, type DiagnosisEvent } from "../lib/ws-message.js";
import { coalesceTelemetry } from "../lib/telemetry-coalesce.js";

export type { DiagnosisEvent };

/** 背景分頁（rAF 停擺）時改用 timer flush 的週期；瀏覽器對背景 timer 本就節流到約 1 秒。 */
const HIDDEN_FLUSH_MS = 1_000;
/** onBatch 連續失敗時 console.error 的最短間隔，避免每幀刷一行 log。 */
const BATCH_ERROR_LOG_INTERVAL_MS = 10_000;

/**
 * 高頻 WebSocket composable：connect + buffer + rAF pump + 分流 + 心跳 + 指數退避重連 + 清理。
 *
 * 憲章 IV 核心：`onmessage` 只把遙測 push 進**非 reactive** buffer；一支 rAF 迴圈每幀
 * `buffer.splice(0)` 後透過 `onBatch` 一次交給 store，使 reactive 提交次數遠少於訊息數。
 * 控制訊息 MUST NOT 混入 telemetry buffer（分流處理）。
 *
 * 韌性：ping/pong 心跳（pong 逾時→close），onclose 非手動關閉→指數退避重連，onerror→close；
 * 每次（重）連線的 `system/connected` 皆觸發 `onConnected`，使 App 重訂閱。
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
   * 診斷事件 MUST NOT 進遙測 buffer，直接分流不破壞遙測 rAF 批次（憲章 IV）。
   */
  onDiagnosisEvent?: (event: DiagnosisEvent) => void;
  /**
   * 選用（009）：收到 `system/metrics` 時直接交 metrics store。低頻（預設 60s 一則），
   * MUST NOT 進遙測 buffer——否則會延遲顯示並污染背壓比值量測（見 ws-message.ts 分派註解）。
   */
  onMetrics?: (metrics: SystemMetrics) => void;
  /** 選用：pong 到達時回報 ping→pong RTT（ms）→ store.setLatency。 */
  onLatency?: (ms: number) => void;
  /**
   * 選用：遙測在進 store 前被捨棄時回報筆數——`overflow` 為 buffer 溢位合併、`invalid` 為
   * 入口型別守衛剔除。交 store.recordDropped，讓背壓計量看得出資料曾被丟棄。
   * 與遙測同樣先累計於非 reactive 計數器，**每幀至多呼叫一次**（硬規則 1）；Pause 期間照常
   * 每幀提交（計數不是畫面內容，凍結它只會讓背壓 badge 在 resume 時一次跳動）。
   */
  onDrop?: (counts: DropCounts) => void;
  /**
   * 選用：pump 每幀讀它——回 true 時**跳過 flush、續存 buffer**（畫面凍結），
   * resume（回 false）後下一幀 flush 整個 buffer＝直接跳到最新。
   */
  isPaused?: () => boolean;
  /** buffer 上限；超過時合併（每台保留第一筆＋state 轉換點＋最新一筆），見 `coalesceTelemetry`。 */
  maxBufferSize?: number;
  /** 心跳週期（ms），預設 15000。 */
  heartbeatMs?: number;
  /** pong 逾時（ms），逾時未回即 close 觸發重連，預設 5000。 */
  pongTimeoutMs?: number;
}

/**
 * clientId 不在此回傳：它的單一來源是 monitoring store（由 `onConnected` 寫入），
 * composable 再留一份只會讓呼叫端不知道該讀哪個。
 */
export interface HighFrequencyWsHandle {
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

  // 非 reactive buffer：高頻 push 不觸發任何 reactive 更新（憲章 IV）。
  let buffer: TelemetryPoint[] = [];
  let rafId: number | null = null;
  let ws: WebSocket | null = null;

  let manualClose = false;
  let attempt = 0;
  let lastPingAt = 0; // 最近一次送 ping 的時刻，供 pong 計 RTT。
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenFlushTimer: ReturnType<typeof setInterval> | null = null;

  // 丟棄筆數的非 reactive 累計；每幀 commitDrops 一次交出（硬規則 1）。
  let pendingOverflow = 0;
  let pendingInvalid = 0;

  let batchErrorCount = 0;
  let lastBatchErrorLogAt = Number.NEGATIVE_INFINITY;

  /**
   * onBatch 失敗時該批直接捨棄（不放回 buffer，否則同一筆壞資料會每幀重炸）。
   * log 節流：第一次立即印，之後每 10 秒最多一則並附累計次數。
   */
  function reportBatchError(error: unknown): void {
    batchErrorCount += 1;
    const t = Date.now();
    if (t - lastBatchErrorLogAt < BATCH_ERROR_LOG_INTERVAL_MS) return;
    lastBatchErrorLogAt = t;
    console.error(
      `[useHighFrequencyWs] onBatch 失敗，該批已捨棄（累計 ${batchErrorCount} 次）`,
      error,
    );
  }

  /** 把整個 buffer 一次交給 onBatch（＝一次批次）。暫停時不動，buffer 續存。 */
  function flush(): void {
    if (options.isPaused?.()) return;
    if (buffer.length === 0) return;
    const batch = buffer.splice(0);
    try {
      onBatch(batch);
    } catch (error) {
      reportBatchError(error);
    }
  }

  /** 把本幀累計的丟棄筆數一次交給 onDrop；先歸零再呼叫，回呼丟例外也不會重複計數。 */
  function commitDrops(): void {
    if (pendingOverflow === 0 && pendingInvalid === 0) return;
    const counts: DropCounts = { overflow: pendingOverflow, invalid: pendingInvalid };
    pendingOverflow = 0;
    pendingInvalid = 0;
    options.onDrop?.(counts);
  }

  /** 一幀的工作：遙測批次＋丟棄計數，各至多一次提交。 */
  function frame(): void {
    try {
      flush();
    } finally {
      commitDrops();
    }
  }

  /**
   * rAF pump：每幀 flush 一次，跨重連持續運作。排程放在 finally：任何例外都不能讓下一幀
   * 停排——否則 buffer 卡在上限、畫面凍結，連線 chip 卻仍顯示 Connected，是無聲故障。
   */
  function pump(): void {
    try {
      frame();
    } finally {
      if (!manualClose) rafId = requestAnimationFrame(pump);
    }
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

  function clearHiddenFlush(): void {
    if (hiddenFlushTimer !== null) {
      clearInterval(hiddenFlushTimer);
      hiddenFlushTimer = null;
    }
  }

  /** 週期送 ping；每次 ping 起 pongTimer，逾時未收 pong 即 close 觸發重連。 */
  function startHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      lastPingAt = Date.now();
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

  function pushTelemetry(points: TelemetryPoint[]): void {
    // 遙測批次：逐筆進**非 reactive** buffer（不逐筆寫 reactive state）。
    for (const point of points) buffer.push(point);
    if (buffer.length > maxBufferSize) {
      // 溢位不截斷最舊：改合併，保住每台最新值與期間的狀態轉換（Event Stream 不斷片）。
      const { kept, dropped } = coalesceTelemetry(buffer, maxBufferSize);
      buffer = kept;
      pendingOverflow += dropped;
    }
  }

  function handleMessage(event: MessageEvent): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      return; // 非 JSON 忽略
    }

    // 分流與入口驗證由純函式 classifyWsMessage 決定（分流不變量可單元測試）。
    const routed = classifyWsMessage(parsed);
    switch (routed.kind) {
      case "telemetry":
        pendingInvalid += routed.rejected;
        pushTelemetry(routed.points);
        return;
      case "diagnosis":
        // 診斷事件：分流交 copilot.store，MUST NOT 進遙測 buffer（憲章 IV）。
        onDiagnosisEvent?.(routed.event);
        return;
      case "metrics":
        // 指標摘要（009）：低頻控制訊息，直接交 metrics store，同樣不進遙測 buffer。
        options.onMetrics?.(routed.metrics);
        return;
      case "control":
        handleControlMessage(routed.message);
        return;
      case "ignore":
        return;
    }
  }

  /** 控制訊息副作用（system/connected 重訂閱並歸零退避；pong 確認心跳）。 */
  function handleControlMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case "system/connected":
        // 退避在這裡才歸零、而非 `open`：「連上又立刻被伺服器關掉」時 open 仍會觸發，
        // 若在 open 歸零就會以約 1 秒週期無限重連；收到 system/connected 才算真的連上。
        attempt = 0;
        if (typeof message.clientId === "string") onConnected(message.clientId);
        break;
      case "pong":
        if (lastPingAt > 0) options.onLatency?.(Date.now() - lastPingAt);
        clearPongTimer(); // 心跳確認
        break;
      // machine/subscribed／system/unauthorized：忽略。
      default:
        break;
    }
  }

  function connect(): void {
    clearReconnect();
    // 舊連線的心跳一併清掉：`online` 快速重連可能發生在舊 socket 的 close 事件到達之前，
    // 舊的 heartbeat／pongTimer 若續跑，會以 `ws?.close()` 把剛建立的新 socket 關掉。
    clearHeartbeat();
    const socket = new WebSocket(url);
    ws = socket;
    // 每個 listener 先確認自己仍是現役 socket：`online` 快速重連可能在舊 socket 尚在 CLOSING
    // 時就建立新連線，舊 socket 遲來的 close 若照常處理，會再排一次重連、疊出第二條連線。
    socket.addEventListener("open", () => {
      if (socket !== ws) return;
      onStatus("connected");
      startHeartbeat();
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (socket !== ws) return;
      handleMessage(event);
    });
    socket.addEventListener("close", () => {
      if (socket !== ws) return;
      clearHeartbeat();
      scheduleReconnect(); // 手動關閉時 ws 已先被清成 null，走不到這裡
    });
    socket.addEventListener("error", () => {
      if (socket !== ws) return;
      socket.close(); // 交給 onclose 統一處理
    });
  }

  /**
   * 網路恢復（筆電睡醒、切回 Wi-Fi）時立即重連，不必等退避計時器（最長約 39 秒）。
   * 連線仍 OPEN／CONNECTING 時不動，交給心跳判斷是否已失效。
   */
  function onOnline(): void {
    if (manualClose) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    connect();
  }

  /**
   * 背景分頁時 rAF 會停擺，buffer 只進不出，最後只能靠溢位合併丟資料；改用低頻 timer 繼續
   * flush，store 與 Event Stream 在背景也保持完整。回到前景即交還給 rAF。
   */
  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      if (hiddenFlushTimer === null) hiddenFlushTimer = setInterval(frame, HIDDEN_FLUSH_MS);
    } else {
      clearHiddenFlush();
    }
  }

  function send(message: ClientControlMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function close(): void {
    if (manualClose) return;
    manualClose = true;
    clearHeartbeat();
    clearReconnect();
    clearHiddenFlush();
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    const socket = ws;
    ws = null; // 先解除現役身分，socket 的 close 事件就不會再排重連
    socket?.close();
    buffer = [];
    pendingOverflow = 0;
    pendingInvalid = 0;
    onStatus("disconnected");
  }

  connect();
  rafId = requestAnimationFrame(pump);
  if (typeof window !== "undefined") window.addEventListener("online", onOnline);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
    // 背景開新分頁時一開始就是 hidden，不會收到 visibilitychange，要先主動判斷一次。
    onVisibilityChange();
  }

  // onScopeDispose 而非 onUnmounted：元件卸載時同樣觸發，也能在測試的 effectScope 內使用。
  onScopeDispose(close);

  return { send, close };
}
