import { defineStore } from "pinia";
import { computed, markRaw, ref, shallowRef, triggerRef } from "vue";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import { fleetHealthOf, type FleetHealthSummary } from "../lib/fleet-health.js";
import { MACHINE_IDS } from "@flow-gatekeeper/contracts";
import { deriveTransitionEvent, pushCapped, type DerivedEvent } from "../lib/events.js";
import { filterMachineIds } from "../lib/machine-search.js";
import { staleClock } from "../lib/stale.js";
import {
  clearSamples,
  createRateSeries,
  droppedInWindow as droppedInWindowOf,
  markStale,
  maxOf,
  pushSample,
  windowRatio as windowRatioOf,
  type RateSample,
  type RateSeries,
} from "../lib/rate-series.js";
import { backpressureRatio } from "../../../shared/lib/backpressure.js";

/** US3 事件保留上限（FR-011）。 */
const EVENT_CAP = 50;

/**
 * 連線三態（design-spec §8.2）。單一資料來源為本 store 的 `connectionStatus`，
 * 元件（AppLayout / TopBar chip）一律讀它，不另立平行狀態。
 */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

/** 收到 `system/unauthorized` 時顯示的簡短提示（TopBar 授權 chip 的 title／aria）。 */
export const AUTH_ERROR_MESSAGE = "即時通道訂閱未授權（WS token 無效），收不到機台資料";

/** 一幀內在進 store 前被捨棄的遙測筆數：`overflow`＝buffer 溢位合併、`invalid`＝入口型別守衛剔除。 */
export interface DropCounts {
  overflow: number;
  invalid: number;
}

/**
 * `MachineLive` —— 前端投影，衍生自契約 `TelemetryPoint`（非契約新增）。
 * 只保留每台機台「最新一筆」快照 + 收到時的 `lastUpdated`（供 stale 判斷）。
 */
export type MachineLive = {
  machineId: string;
  state: MachineState;
  telemetry: TelemetryPoint["telemetry"];
  lastUpdated: number;
};

function project(point: TelemetryPoint, receivedAt: number): MachineLive {
  return {
    machineId: point.machineId,
    state: point.state,
    telemetry: { ...point.telemetry },
    lastUpdated: receivedAt,
  };
}

export const useMonitoringStore = defineStore("monitoring", () => {
  // ── State ──────────────────────────────────────────────────────────
  /**
   * 每台機台最新快照；key 為 machineId，只保留最新值（覆寫）。
   * 用 shallowRef + markRaw 而非深層 ref：批次內逐筆 `set` 不各自觸發依賴，改在迴圈後
   * `triggerRef` 一次，讓「一批＝一次 reactive 提交」在語意上成立，而不只靠 scheduler 合併。
   * 快照物件整筆替換、從不就地修改，所以不需要深層追蹤。
   */
  const machines = shallowRef<Map<string, MachineLive>>(markRaw(new Map()));
  /** 目前選取機台（至多一台）；供 selected 視覺與 005 診斷觸發。 */
  const selectedMachineId = ref<string | null>(null);
  /** 即時通道三態，初始 disconnected。 */
  const connectionStatus = ref<ConnectionStatus>("disconnected");
  /**
   * **現役**連線的識別（`system/connected` 派發），供 005 當 POST /diagnoses 的 socketId。
   * 一離開 connected（斷線／重連中／pong 逾時／手動關閉）即清空：舊 clientId 綁的 socket
   * 已不存在，拿它送診斷只會讓結果送往舊連線（WEB-3）。重連偵測另看 copilot.store 的
   * `lastClientId`，兩者語意不同。
   */
  const clientId = ref<string | null>(null);
  /** 本頁是否曾收到過 `system/connected`；只供橫幅區分「首次連線中」與「已斷線」。 */
  const everConnected = ref(false);
  /**
   * 本次連線是否已收到 `machine/subscribed`（＝Gateway 已把這條連線列為授權）。
   * 在 `system/connected` 與 `machine/subscribed` 之間約 1 RTT 的空窗送診斷必得 409，
   * 所以 `isLive` 也要求它；離開 connected 即清空。
   */
  const subscribed = ref(false);
  /** 訂閱授權錯誤（收到 `system/unauthorized`）；`machine/subscribed` 成功後清除。 */
  const authError = ref<string | null>(null);
  /**
   * 累積抵達前端的 telemetry 筆數（背壓分子）。**含**溢位合併丟棄與格式不符剔除的筆數——
   * 它回答的是「網路上收到多少」，若只算套用成功的筆數，背景分頁或 Pause 後比值會偏低且看不出原因。
   */
  const receivedMessages = ref(0);
  /** buffer 溢位時被合併丟棄的筆數（每台保留最新＋轉換點，其餘捨棄）。 */
  const droppedMessages = ref(0);
  /** 未通過入口型別守衛而被剔除的筆數。 */
  const invalidMessages = ref(0);
  /** 累積 rAF 批次提交次數（背壓分母）。 */
  const renderedBatches = ref(0);
  /**
   * 低頻更新的當前時間戳（每秒一次）。恆照走——metrics 面板的新鮮度與診斷 watchdog 依賴它，
   * 不能被 Pause 凍結；卡片／Fleet Health 的 stale 改讀下方 `staleNow`。
   */
  const now = ref(Date.now());
  /** US3 前端衍生事件（最近 50 筆，最新在頂端）；於 applyTelemetryBatch 批次點衍生。 */
  const events = ref<DerivedEvent[]>([]);
  /** US3 事件唯一鍵用單調序號（非 reactive）：保 v-for key 在同批次同機台多筆時仍唯一。 */
  let eventSeq = 0;
  /** US4 即時通道 ping→pong RTT（ms）；null＝尚無量測（首個 pong 前 / 斷線後重置）。 */
  const latencyMs = ref<number | null>(null);
  /** US4 pause 開關；true 時 composable pump 跳過 flush、續存 buffer（畫面凍結）。 */
  const paused = ref(false);
  /** 按下 Pause 的時刻；未暫停為 null。 */
  const pausedAt = ref<number | null>(null);
  /** US4 search 查詢字串；空＝全部。sidebar 清單與主區卡片共用 `visibleMachineIds`。 */
  const searchQuery = ref("");
  /**
   * 013 US2 背壓速率序列（最近 60 秒，data-model §3）。只在 1 Hz `tickNow` 推入差分樣本，
   * **不在 rAF 幀或 ws handler**（憲章 IV）：就地修改後 `triggerRef` 一次，下列 getter 由它衍生。
   * 序列本身不需深層追蹤，故 shallowRef + markRaw。
   */
  const rateSeries = shallowRef<RateSeries>(markRaw(createRateSeries()));
  /**
   * 自載入起的累計比值（tooltip 用，沿用 `backpressureRatio`）。在 tick 取樣而非 computed：
   * 兩個計數器每幀都在變，computed 會讓讀它的背壓 strip 每幀重繪；tick 取樣則與序列同為 1 Hz。
   * 尚無任何批次時為 null（顯示「—」，不顯示成 0:1）。
   */
  const cumulativeRatio = ref<number | null>(null);

  // ── Getters ────────────────────────────────────────────────────────
  /**
   * 「連線真的活著」：狀態為 connected、已收到本次連線的 `system/connected`（clientId）且
   * 已完成訂閱（`machine/subscribed`）。pong 逾時由 composable 直接轉為 reconnecting，
   * socket 關閉亦同，兩者都會清空 clientId／subscribed，因此同時涵蓋心跳逾時與 socket 關閉。
   * Diagnose 是否可用以它為準，不看「曾拿到過 clientId」。
   */
  const isLive = computed(
    () => connectionStatus.value === "connected" && clientId.value !== null && subscribed.value,
  );

  /** selectedMachineId 對應的快照，供 TopBar／005 使用。 */
  const selectedMachine = computed<MachineLive | null>(() =>
    selectedMachineId.value !== null
      ? (machines.value.get(selectedMachineId.value) ?? null)
      : null,
  );

  /**
   * stale 判斷用時鐘：Pause 且連線中凍結在 `pausedAt`，否則等於 `now`（取捨見 `staleClock`）。
   * 卡片 Stale badge、相對時間與 Fleet Health 共用這一個值，確保三處一致。
   */
  const staleNow = computed(() =>
    staleClock(now.value, pausedAt.value, connectionStatus.value === "connected"),
  );

  /**
   * US2 Fleet Health 四類聚合。委派純函式 `fleetHealthOf`，走固定名冊 MACHINE_IDS
   * （total 穩定＝5）。依賴 `machines` 與 `staleNow`（每秒 tick 重算 stale），屬低頻 reactive，
   * 不逐筆 telemetry 觸發（憲章 IV）。
   */
  const fleetHealth = computed<FleetHealthSummary>(() =>
    fleetHealthOf(machines.value, staleNow.value, MACHINE_IDS),
  );

  /**
   * US4 search 結果——sidebar 清單與主區卡片**共用**此單一 computed（FR-015、SC-006），
   * 確保兩處過濾一致。空查詢回全部名冊。
   */
  const visibleMachineIds = computed<string[]>(() =>
    filterMachineIds(MACHINE_IDS, searchQuery.value),
  );

  // ── 013 US2 背壓 getter：全部由 `rateSeries` 衍生（每秒至多觸發一次） ──
  /**
   * 樣本的**新陣列**（由舊到新）。序列是就地修改的同一個陣列，若直接把 `samples` 當 prop 傳，
   * 子元件的 prop 比對會判定「沒變」而不重繪；每秒複製 60 筆換一個新參照，成本可忽略。
   */
  const rateSamples = computed<readonly RateSample[]>(() => [...rateSeries.value.samples]);
  /** 最新一筆樣本（strip 的「每秒訊息／每秒批次」）；尚無樣本為 null。 */
  const latestRate = computed<RateSample | null>(() => {
    const samples = rateSeries.value.samples;
    return samples[samples.length - 1] ?? null;
  });
  /**
   * 走勢線 y 軸的共同上限：60 秒內訊息與批次速率的最大值（實務上即訊息峰值）。兩條線共用同一個上限，
   * 線下面積的比例才會與比值一致（US2 AS2）；取兩者之大，避免批次多於訊息的極端情況畫出界。
   */
  const ratePeak = computed(() =>
    Math.max(maxOf(rateSeries.value, "msgsPerSec"), maxOf(rateSeries.value, "batchesPerSec")),
  );
  /** 60 秒視窗比值（FR-009 主顯示）；批次總和為 0 時為 null（顯示「—」）。 */
  const windowRatio = computed(() => windowRatioOf(rateSeries.value));
  /** 60 秒視窗內的捨棄總數（FR-011；> 0 才顯示）。 */
  const droppedInWindow = computed(() => droppedInWindowOf(rateSeries.value));
  /**
   * 「連線中斷」標示：序列已停止推入，且本頁曾連上過——首次連線前序列同樣不推入，但那是
   * 「連線中」（橫幅已說明），不該標成中斷。
   */
  const rateStale = computed(() => rateSeries.value.stale && everConnected.value);

  // ── Actions ────────────────────────────────────────────────────────
  /**
   * 每次呼叫 = 一個 rAF 幀 = 一次批次（不論 batch 幾筆）：
   * 逐筆覆寫該台最新快照，received += batch.length，rendered += 1。
   */
  function applyTelemetryBatch(batch: TelemetryPoint[]): void {
    const receivedAt = Date.now();
    const map = machines.value;
    for (const point of batch) {
      // US3：覆寫快照**前**讀 prevState，於狀態轉入 warning/critical 時衍生一筆事件（去重、上限 50）。
      // 事件時間用 payload 自身 timestamp（非批次 receivedAt）：pause 後 resume 一次沖出整段
      // buffer 時，各筆仍保留真實發生時序，不會全被壓成同一個 resume 時刻（review 006）。
      // timestamp 解析失敗才退回 receivedAt。id 唯一性另由單調 eventSeq 保證（見 events.ts）。
      const prevState = map.get(point.machineId)?.state;
      const parsedTs = Date.parse(point.timestamp);
      const eventTs = Number.isNaN(parsedTs) ? receivedAt : parsedTs;
      const event = deriveTransitionEvent(prevState, point.state, point.machineId, eventTs, eventSeq);
      if (event) {
        eventSeq += 1;
        pushCapped(events.value, event, EVENT_CAP);
      }
      map.set(point.machineId, markRaw(project(point, receivedAt)));
    }
    if (batch.length > 0) triggerRef(machines);
    receivedMessages.value += batch.length;
    renderedBatches.value += 1;
  }

  /**
   * composable 回報在進 store 前就被捨棄的筆數。兩者都計入 `receivedMessages`（它們確實抵達了），
   * 但不計入 `renderedBatches`（沒有觸發任何提交）。
   *
   * 呼叫端（`useHighFrequencyWs`）先把丟棄筆數累計在非 reactive 計數器，每幀 flush 時才
   * 一次交進來（硬規則 1）：本 action 每幀至多一次，不隨訊息數成長。
   */
  function recordDropped(counts: DropCounts): void {
    const overflow = Math.max(0, counts.overflow);
    const invalid = Math.max(0, counts.invalid);
    if (overflow === 0 && invalid === 0) return;
    if (overflow > 0) droppedMessages.value += overflow;
    if (invalid > 0) invalidMessages.value += invalid;
    receivedMessages.value += overflow + invalid;
  }

  function selectMachine(machineId: string): void {
    selectedMachineId.value = machineId;
  }

  function setConnectionStatus(status: ConnectionStatus): void {
    // 離開 connected（斷線/重連）即清除延遲量測，避免重連後 chip 沿用上一段連線的過期 RTT；
    // 重連後需等下一個 pong 才重新有值（首個 pong 前顯示 —）。
    if (status !== "connected") {
      latencyMs.value = null;
      clientId.value = null; // 舊連線識別隨連線失效（WEB-3）
      subscribed.value = false; // 新連線要重新訂閱才算授權
    }
    connectionStatus.value = status;
  }

  /**
   * 識別換了＝換了一條連線：舊連線的訂閱授權不延續，須等新連線的 `machine/subscribed`。
   * 平常離開 connected 時 `setConnectionStatus` 已清掉 subscribed；這裡補上「狀態未經過
   * reconnecting 就換到新 clientId」的路徑，不讓 isLive 以新 id 搭配舊連線的授權。
   */
  function setClientId(id: string): void {
    if (clientId.value !== id) subscribed.value = false;
    clientId.value = id;
    everConnected.value = true;
  }

  /**
   * composable `onAuthResult`：`machine/subscribed`→true（標記已訂閱、清除錯誤）、
   * `system/unauthorized`→false（未訂閱、記錄錯誤）。未授權時 api 會在逾時後 close(1008)，
   * 前端走一般退避重連；authError 保留到下一次訂閱成功。
   */
  function setAuthorized(authorized: boolean): void {
    subscribed.value = authorized;
    authError.value = authorized ? null : AUTH_ERROR_MESSAGE;
  }

  /**
   * 1 Hz tick（App 的 setInterval）：推進 `now`，並為背壓序列取一次差分樣本。
   * 先依連線狀態同步 stale（`markStale` 冪等；重連時清掉差分基準，斷線期間的累積量不灌進單一格），
   * 重連那一刻再清空斷線前的舊樣本（否則 60 秒視窗會混入斷線前的資料），然後推入；
   * Pause 期間照常推入（計數不是畫面內容）。序列有變才 `triggerRef`，每秒至多一次。
   */
  function tickNow(): void {
    const t = Date.now();
    now.value = t;
    const series = rateSeries.value;
    const wasStale = series.stale;
    markStale(series, connectionStatus.value !== "connected");
    if (wasStale && !series.stale) clearSamples(series);
    const pushed = pushSample(
      series,
      {
        receivedMessages: receivedMessages.value,
        renderedBatches: renderedBatches.value,
        droppedMessages: droppedMessages.value,
      },
      t,
    );
    if (pushed || wasStale !== series.stale) triggerRef(rateSeries);
    cumulativeRatio.value =
      renderedBatches.value > 0
        ? backpressureRatio(receivedMessages.value, renderedBatches.value)
        : null;
  }

  /** US4：切換 pause（畫面凍結／恢復）。 */
  function togglePause(): void {
    paused.value = !paused.value;
    pausedAt.value = paused.value ? Date.now() : null;
  }

  /** US4：由 composable `onLatency` 餵入 ping/pong RTT。 */
  function setLatency(ms: number): void {
    latencyMs.value = ms;
  }

  /** US4：更新 search 查詢字串（TopBar 綁定）。 */
  function setSearchQuery(query: string): void {
    searchQuery.value = query;
  }

  return {
    machines,
    selectedMachineId,
    connectionStatus,
    clientId,
    everConnected,
    subscribed,
    authError,
    isLive,
    receivedMessages,
    droppedMessages,
    invalidMessages,
    renderedBatches,
    now,
    staleNow,
    events,
    latencyMs,
    paused,
    pausedAt,
    searchQuery,
    selectedMachine,
    fleetHealth,
    visibleMachineIds,
    rateSeries,
    rateSamples,
    latestRate,
    ratePeak,
    windowRatio,
    droppedInWindow,
    rateStale,
    cumulativeRatio,
    applyTelemetryBatch,
    recordDropped,
    selectMachine,
    setConnectionStatus,
    setClientId,
    setAuthorized,
    tickNow,
    togglePause,
    setLatency,
    setSearchQuery,
  };
});
