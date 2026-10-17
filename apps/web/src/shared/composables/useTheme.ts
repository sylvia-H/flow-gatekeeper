import { readonly, ref, type Ref } from "vue";
import { readPreference, writePreference } from "./useLocalPreference.js";

/**
 * 深淺主題（research R1、ui-contract §1–§2）。
 *
 * - 根屬性 `<html data-theme="light|dark">` 驅動 theme.css 的兩組同名變數；切換只改這個屬性，零 re-render。
 * - 偏好存 `fg.theme`；首次載入預設 `light`，**不讀 `prefers-color-scheme`**（spec Assumptions）。
 * - 切換瞬間在 `<html>` 加 `data-theme-switching`，theme.css 據此停用所有 transition，
 *   避免各元件以不同時序漸變而閃爍；兩個 animation frame 後移除（確保新變數已套用並繪製一次）。
 */
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "fg.theme";

function parseTheme(raw: string): Theme {
  if (raw === "light" || raw === "dark") return raw;
  throw new Error(`未知的主題值：${raw}`);
}

/** 讀已存的主題偏好；不存在、壞值或 storage 不可用時為 `light`。 */
export function savedTheme(): Theme {
  return readPreference<Theme>(THEME_STORAGE_KEY, "light", parseTheme);
}

/** 在 `createApp` 之前呼叫：立即把已存主題套到 `<html>`，避免首幀以錯誤主題繪製。 */
export function applySavedTheme(): Theme {
  const theme = savedTheme();
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
  return theme;
}

/** 全站共用一份狀態（單例）：多個元件呼叫 `useTheme()` 拿到同一個 ref。 */
let current: Ref<Theme> | null = null;
/**
 * 移除 `data-theme-switching` 的待執行 frame（全站只留一個）。兩幀內連續切換時先取消前一組再重排，
 * 否則前一次切換排定的移除會在新主題繪製前就拿掉保護（合併門第 1 輪 low）。
 */
let pendingFrame: number | null = null;

/** `theme` 為唯讀：一律經 `apply`／`toggle` 變更，才能同步 `<html>`、偏好與切換保護。 */
export function useTheme(): {
  theme: Readonly<Ref<Theme>>;
  toggle: () => void;
  apply: (next: Theme) => void;
} {
  if (!current) {
    // 以 `<html>` 上已套用的主題為準（applySavedTheme 已在掛載前設好）；沒有時才回頭讀偏好。
    const onRoot = typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined;
    current = ref<Theme>(onRoot === "light" || onRoot === "dark" ? onRoot : savedTheme());
  }
  const theme = current;

  function apply(next: Theme): void {
    const root = document.documentElement;
    root.setAttribute("data-theme-switching", "");
    root.dataset.theme = next;
    theme.value = next;
    writePreference(THEME_STORAGE_KEY, next);
    if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null;
        root.removeAttribute("data-theme-switching");
      });
    });
  }

  function toggle(): void {
    apply(theme.value === "dark" ? "light" : "dark");
  }

  return { theme: readonly(theme), toggle, apply };
}

/** 僅供測試：重置單例。 */
export function resetThemeStateForTest(): void {
  current = null;
  pendingFrame = null;
}
