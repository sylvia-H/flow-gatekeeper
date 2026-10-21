import { computed, onScopeDispose, watch } from "vue";

/**
 * 周邊注意力訊號（013 critique 2026-10-17 P2「沒有周邊注意力訊號」）：分頁不在前景時，
 * 從分頁標題與 favicon 就看得出「有機台嚴重」或「即時通道斷了」。
 *
 * 決策（純函式 `documentAlertOf`），優先序與主區橫幅同向（斷線 ＞ 其他，見 `shared/lib/status-banner.ts`）：
 * 1. 曾連上後離開 connected：「○ 重新連線中 · flow-gatekeeper」／「○ 已斷線 · flow-gatekeeper」，favicon 換離線版
 *    （空心 stale 圓圈）。斷線 10 秒後機台全數轉停滯、嚴重數歸 0，若不標離線，標題會退回「flow-gatekeeper」讀成一切正常。
 *    首次連線中（從未連上）不標，與橫幅的中性「連線中…」一致。
 * 2. 嚴重台數 > 0：「● 嚴重 N · flow-gatekeeper」，favicon 換嚴重版（實心 crit 點）。
 * 3. 其餘：「flow-gatekeeper」與基礎 favicon。警告不上分頁（mock 會週期性出警告尖峰，分頁標題跟著跳只會讓人麻痺）。
 *
 * 寫入時機：只 watch 衍生出的字串，值變了才寫 `document.title`／`<link rel="icon">` 的 `href`；
 * 來源（`fleetHealth`）每幀或每秒重算都不會多寫一次 DOM。不閃爍、不輪播，與 `prefers-reduced-motion` 無關；
 * 標題變化不設 live region（畫面上的機群健康與連線 chip 已有可讀名稱）。
 * 依賴方向：shared 不 import domains，呼叫端（App）把 store 的值以 getter 傳進來。
 */

export const APP_TITLE = "flow-gatekeeper";

/** 與 monitoring store 的 `ConnectionStatus` 同值（shared 不 import domains，於此另列）。 */
export type DocumentAlertConnection = "connected" | "reconnecting" | "disconnected";

export interface DocumentAlertInput {
  /** 機群健康的嚴重台數（`fleetHealth.critical`，停滯的機台不算）。 */
  critical: number;
  connection: DocumentAlertConnection;
  /** 本頁是否曾連上過（區分「首次連線中」與「已斷線」）。 */
  everConnected: boolean;
}

/** favicon 三種版本，對應 `public/` 下的 `favicon.svg`、`favicon-critical.svg`、`favicon-offline.svg`。 */
export type FaviconKind = "normal" | "critical" | "offline";

export interface DocumentAlert {
  title: string;
  icon: FaviconKind;
}

export function documentAlertOf(input: DocumentAlertInput): DocumentAlert {
  if (input.everConnected && input.connection !== "connected") {
    const label = input.connection === "reconnecting" ? "重新連線中" : "已斷線";
    return { title: `○ ${label} · ${APP_TITLE}`, icon: "offline" };
  }
  if (input.critical > 0) return { title: `● 嚴重 ${input.critical} · ${APP_TITLE}`, icon: "critical" };
  return { title: APP_TITLE, icon: "normal" };
}

/** favicon 的 URL；`base` 預設為 Vite 的 `BASE_URL`（以 `/` 結尾）。 */
export function faviconHref(kind: FaviconKind, base: string = import.meta.env.BASE_URL): string {
  return `${base}${kind === "normal" ? "favicon.svg" : `favicon-${kind}.svg`}`;
}

/**
 * 在元件 setup（或 effectScope）內呼叫。找不到 `<link rel="icon">` 時自建一個；
 * scope 結束時還原原本的標題與 href（自建的 link 直接移除）。沒有 `document` 的環境不做事。
 */
export function useDocumentAlert(source: () => DocumentAlertInput): void {
  if (typeof document === "undefined") return;

  const originalTitle = document.title;
  const existing = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  const link = existing ?? document.createElement("link");
  if (!existing) {
    link.rel = "icon";
    link.type = "image/svg+xml";
    document.head.appendChild(link);
  }
  const originalHref = link.getAttribute("href");

  const alert = computed(() => documentAlertOf(source()));
  // 再各取一層字串 computed：`alert` 每次重算都是新物件，字串沒變時下游 watch 不會被觸發。
  const title = computed(() => alert.value.title);
  const icon = computed(() => alert.value.icon);

  watch(
    title,
    (next) => {
      if (document.title !== next) document.title = next;
    },
    { immediate: true },
  );
  watch(
    icon,
    (kind) => {
      const href = faviconHref(kind);
      if (link.getAttribute("href") !== href) link.setAttribute("href", href);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    document.title = originalTitle;
    if (!existing) link.remove();
    else if (originalHref === null) link.removeAttribute("href");
    else link.setAttribute("href", originalHref);
  });
}
