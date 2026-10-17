import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { applySavedTheme } from "./shared/composables/useTheme.js";
import "./styles/tailwind.css";

/**
 * apps/web entry —— 監控台正式掛載點（research R8，取代 001 的 createGatekeeperApp 骨架）。
 *
 * 僅在瀏覽器環境掛載（有 document 與 #app 時），使 entry smoke 測試可於 node
 * 乾淨 import 而不觸發掛載。掛載前先套用已存主題（`fg.theme`，預設 light）：之後的切換在同一幀換裝；
 * 但首幀仍以 index.html 寫死的 `data-theme="light"` 繪製（不用 inline script 提前套用——demo 的 nginx 有 CSP），
 * 已存為 dark 時，可能先閃一下 light 才在本段執行後換成 dark。
 */
if (typeof document !== "undefined" && document.getElementById("app")) {
  applySavedTheme();
  createApp(App).use(createPinia()).mount("#app");
}
