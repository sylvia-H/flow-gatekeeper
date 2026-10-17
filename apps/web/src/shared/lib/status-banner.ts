/**
 * 主區橫幅（連線／授權／暫停）的決策：純函式，不碰 store、不 import domains（App 把 monitoring store 的值傳進來）。
 *
 * 優先序：斷線類（重新連線中、已斷線、首次連線中）＞ 未授權 ＞ 暫停 ＞ 無。
 * - 連線或授權有狀況時，資料本身已停或不可信，比「操作者自己按了暫停」更要緊，所以蓋過暫停橫幅。
 * - 暫停橫幅只在連線正常、授權正常、`paused` 且 `pausedAt` 有值時出現（`pausedAt` 是「暫停於 HH:mm:ss」的來源，
 *   缺值就不顯示半截句子）。材質用中性玻璃：暫停是操作者自己的選擇、不是故障，不借警告色。
 */

/** 與 monitoring store 的 `ConnectionStatus` 同值（shared 不 import domains，於此另列）。 */
export type BannerConnectionStatus = "connected" | "reconnecting" | "disconnected";

export interface StatusBanner {
  text: string;
  /** 外觀 class（邊框／底／文字色）。 */
  cls: string;
  /** 有值＝暫停橫幅：文字後接「暫停於 HH:mm:ss」並內嵌「恢復」鈕。 */
  pausedAt?: number;
}

export function bannerOf(
  status: BannerConnectionStatus,
  everConnected: boolean,
  authError: string | null,
  paused: boolean,
  pausedAt: number | null,
): StatusBanner | null {
  switch (status) {
    case "reconnecting":
      return { text: "重新連線中…（畫面保留最後已知資料）", cls: "border-warn bg-warn-bg text-warn-fg" };
    case "disconnected":
      return everConnected
        ? { text: "已斷線，畫面保留最後已知資料，可能已過時", cls: "border-crit bg-crit-bg text-crit-fg" }
        : { text: "連線中…", cls: "border-edge bg-surface/72 text-ink-2" };
    case "connected":
      if (authError !== null) return { text: authError, cls: "border-crit bg-crit-bg text-crit-fg" };
      return paused && pausedAt !== null
        ? { text: "已暫停畫面更新", cls: "border-edge bg-surface/72 text-ink", pausedAt }
        : null;
  }
}
