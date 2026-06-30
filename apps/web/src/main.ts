import { createApp, h } from "vue";

/**
 * apps/web entry — Feature 001 僅為可編譯的最小骨架（FR-013）。
 *
 * MUST NOT 在本 feature 實作監控台 UI、WebSocket 連線或 telemetry 的
 * requestAnimationFrame 批次提交；視覺與即時行為依 design-spec 留待後續 feature。
 * 匯出 factory 並只在瀏覽器環境掛載，使 entry smoke 測試可乾淨 import（FR-014）。
 */
export function createGatekeeperApp() {
  return createApp({
    render: () => h("div", "flow-gatekeeper web skeleton (001)"),
  });
}

if (typeof document !== "undefined" && document.getElementById("app")) {
  createGatekeeperApp().mount("#app");
}
