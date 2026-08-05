import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles/tailwind.css";

/**
 * apps/web entry —— 監控台正式掛載點（research R8，取代 001 的 createGatekeeperApp 骨架）。
 *
 * 僅在瀏覽器環境掛載（有 document 與 #app 時），使 entry smoke 測試可於 node
 * 乾淨 import 而不觸發掛載。
 */
if (typeof document !== "undefined" && document.getElementById("app")) {
  createApp(App).use(createPinia()).mount("#app");
}
