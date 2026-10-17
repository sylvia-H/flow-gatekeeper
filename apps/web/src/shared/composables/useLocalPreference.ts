/**
 * localStorage 偏好讀寫（ui-contract §2）。
 *
 * localStorage 可能不可用（隱私模式、被封鎖、配額滿、非瀏覽器環境），讀寫一律 try/catch：
 * 讀取失敗或內容無法解析時回 `fallback`，寫入失敗時靜默略過——偏好只是便利，
 * 不得因此讓畫面壞掉或拋錯。純函式、不依賴 Vue 與 store（shared 層不得 import domains/）。
 */

/**
 * 讀取偏好：`parse` 把原始字串轉成值；key 不存在、storage 不可用或 `parse` 拋錯時回 `fallback`。
 * 要拒絕不合法的值（例如列舉外的字串），讓 `parse` 拋錯即可。
 */
export function readPreference<T>(key: string, fallback: T, parse: (raw: string) => T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    return parse(raw);
  } catch {
    return fallback;
  }
}

/** 寫入偏好；storage 不可用或寫入失敗時靜默略過。 */
export function writePreference(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // 偏好寫不進去不影響當前操作，下次載入以預設值運作。
  }
}
