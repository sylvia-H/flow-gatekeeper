import { computed, onScopeDispose, ref, watch } from "vue";

/**
 * 周邊注意力訊號（013 critique 2026-10-17 P2「沒有周邊注意力訊號」）：分頁不在前景時，
 * 從分頁標題與 favicon 就看得出「有機台嚴重」或「即時通道斷了」。
 *
 * 決策（純函式 `documentAlertOf`），離線判定與主區橫幅 `bannerOf`（`shared/lib/status-banner.ts`）逐態對應，優先序同向（斷線 ＞ 其他）：
 * 1. 離線＝`reconnecting`（不論是否曾連上，與橫幅「重新連線中…」相同），或 `disconnected` 且曾連上：
 *    「○ 重新連線中 · flow-gatekeeper」／「○ 已斷線 · flow-gatekeeper」，favicon 換離線版（空心 stale 圓圈）。
 *    實務上斷線時是「重新連線中」（退避重連）；`disconnected` 只在即時通道被卸載時出現。
 *    斷線 10 秒後機台全數轉停滯、嚴重數歸 0，若不標離線，標題會退回「flow-gatekeeper」讀成一切正常。
 *    第一次連線嘗試結果出來前（`disconnected` 且從未連上）不標，與橫幅的中性「連線中…」一致。
 * 2. 嚴重台數 > 0：「● 嚴重 N · flow-gatekeeper」，favicon 換嚴重版（實心 crit 點）。
 * 3. 其餘：「flow-gatekeeper」與基礎 favicon。警告不上分頁（mock 會週期性出警告尖峰，分頁標題跟著跳只會讓人麻痺）。
 *
 * favicon 在執行期組成 SVG data URL，顏色讀 `<html>` 上**目前主題**的 token（`--c-surface` 等，theme.css 是唯一色值來源，
 * 本檔不寫任何色值）；`data-theme` 改變時（`MutationObserver`）重組。讀不到 token（例如測試環境沒有載入 theme.css）
 * 時不動 favicon、只改標題。
 *
 * 寫入時機：只 watch 衍生出的字串，值變了才寫 `document.title`／`<link rel="icon">` 的 `href`；
 * 來源（`fleetHealth`）每幀或每秒重算都不會多寫一次 DOM，`getComputedStyle` 也只在 favicon 版本或主題變化時才讀。
 * 不閃爍、不輪播，與 `prefers-reduced-motion` 無關；標題變化不設 live region（畫面上的機群健康與連線 chip 已有可讀名稱）。
 * 依賴方向：shared 不 import domains，呼叫端（App）把 store 的值以 getter 傳進來。
 */

export const APP_TITLE = "flow-gatekeeper";

/** 與 monitoring store 的 `ConnectionStatus` 同值（shared 不 import domains，於此另列）。 */
export type DocumentAlertConnection = "connected" | "reconnecting" | "disconnected";

export interface DocumentAlertInput {
  /** 機群健康的嚴重台數（`fleetHealth.critical`，停滯的機台不算）。 */
  critical: number;
  connection: DocumentAlertConnection;
  /** 本頁是否曾連上過（區分「第一次連線中」與「已斷線」）。 */
  everConnected: boolean;
}

/** favicon 三種版本。 */
export type FaviconKind = "normal" | "critical" | "offline";

export interface DocumentAlert {
  title: string;
  icon: FaviconKind;
}

export function documentAlertOf(input: DocumentAlertInput): DocumentAlert {
  const offline =
    input.connection === "reconnecting" || (input.connection === "disconnected" && input.everConnected);
  if (offline) {
    const label = input.connection === "reconnecting" ? "重新連線中" : "已斷線";
    return { title: `○ ${label} · ${APP_TITLE}`, icon: "offline" };
  }
  if (input.critical > 0) return { title: `● 嚴重 ${input.critical} · ${APP_TITLE}`, icon: "critical" };
  return { title: APP_TITLE, icon: "normal" };
}

/** favicon 用到的 token（theme.css 的 `--c-<name>`）；值為 CSS 色彩字串 `rgb(R,G,B)`。 */
export const FAVICON_TOKENS = ["surface", "ink", "ink-3", "accent", "crit", "stale"] as const;
export type FaviconColors = Record<(typeof FAVICON_TOKENS)[number], string>;

/**
 * 讀 `<html>` 上目前主題的 favicon token。theme.css 存 `R G B` 三元組，轉成 `rgb(R,G,B)`；
 * 任一個缺值或格式不符（例如沒有載入 theme.css）回 `null`。
 */
export function readFaviconColors(root: Element = document.documentElement): FaviconColors | null {
  const style = getComputedStyle(root);
  const colors: Partial<FaviconColors> = {};
  for (const name of FAVICON_TOKENS) {
    const m = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/.exec(style.getPropertyValue(`--c-${name}`).trim());
    if (!m) return null;
    colors[name] = `rgb(${m[1]},${m[2]},${m[3]})`;
  }
  return colors as FaviconColors;
}

/**
 * favicon 的 SVG 原文（32×32 viewBox 的極簡玻璃量具）：`surface` 玻璃片＋2px `ink` 框、左上三道 2px `ink-3` 蝕刻刻度、
 * 下方 `accent` 液柱；嚴重版右上加實心 `crit` 點（2px `surface` 圈與框線分開），離線版改 3px `stale` 空心圈。
 */
export function faviconSvg(kind: FaviconKind, c: FaviconColors): string {
  const marker =
    kind === "critical"
      ? `<circle cx="23" cy="10" r="6.5" fill="${c.crit}" stroke="${c.surface}" stroke-width="2"/>`
      : kind === "offline"
        ? `<circle cx="23" cy="10" r="5" fill="${c.surface}" stroke="${c.stale}" stroke-width="3"/>`
        : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect x="2" y="2" width="28" height="28" rx="5" fill="${c.surface}" stroke="${c.ink}" stroke-width="2"/>` +
    `<path d="M7 8h6M7 13h4M7 18h6" fill="none" stroke="${c["ink-3"]}" stroke-width="2"/>` +
    `<rect x="7" y="21" width="18" height="5" fill="${c.accent}"/>` +
    marker +
    `</svg>`
  );
}

/** SVG data URL；`encodeURIComponent` 會把 `#`、`<`、`"`、空白等全部編碼。 */
export function faviconDataUrl(kind: FaviconKind, colors: FaviconColors): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(faviconSvg(kind, colors))}`;
}

/**
 * 在元件 setup（或 effectScope）內呼叫。第一次要寫 favicon 時才找 `<link rel="icon">`、找不到就自建；
 * scope 結束時還原原本的標題與 href（自建的 link 直接移除）、停止監看 `data-theme`。沒有 `document` 的環境不做事。
 */
export function useDocumentAlert(source: () => DocumentAlertInput): void {
  if (typeof document === "undefined") return;

  const originalTitle = document.title;
  const root = document.documentElement;

  const alert = computed(() => documentAlertOf(source()));
  // 再各取一層字串 computed：`alert` 每次重算都是新物件，字串沒變時下游 watch 不會被觸發。
  const title = computed(() => alert.value.title);
  const icon = computed(() => alert.value.icon);

  // 主題換了（`<html data-theme>`）就讓 favicon 重讀 token。
  const themeVersion = ref(0);
  const observer =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          themeVersion.value += 1;
        })
      : null;
  observer?.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

  const href = computed<string | null>(() => {
    void themeVersion.value;
    const colors = readFaviconColors(root);
    return colors ? faviconDataUrl(icon.value, colors) : null;
  });

  watch(
    title,
    (next) => {
      // 冗餘防護：上游已是字串 computed，值沒變不會觸發；這裡只擋「外部已改成同一個值」時的多寫。
      if (document.title !== next) document.title = next;
    },
    { immediate: true },
  );

  let link: HTMLLinkElement | null = null;
  let created = false;
  let originalHref: string | null = null;
  watch(
    href,
    (next) => {
      if (next === null) return; // 讀不到 token：不動 favicon
      if (!link) {
        link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
        if (link) {
          originalHref = link.getAttribute("href");
        } else {
          link = document.createElement("link");
          link.rel = "icon";
          link.type = "image/svg+xml";
          document.head.appendChild(link);
          created = true;
        }
      }
      if (link.getAttribute("href") !== next) link.setAttribute("href", next);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    observer?.disconnect();
    document.title = originalTitle;
    if (!link) return;
    if (created) link.remove();
    else if (originalHref === null) link.removeAttribute("href");
    else link.setAttribute("href", originalHref);
  });
}
