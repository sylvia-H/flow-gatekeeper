import { defineConfig } from "vitest/config";

// vitest 必須永遠對 workspace 套件的原始碼測試（packages/* exports 的 "development" condition → src），
// 避免拿舊 dist（或乾淨 clone 根本沒有 dist）而假綠。
// Vite 5 依 NODE_ENV 自動選 development／production condition，且會過濾掉使用者在 resolve.conditions
// 給的 development／production——寫 resolve.conditions 無效；因此改成不讓 NODE_ENV=production 滲進測試。
// 注意：Vite 6／vitest 3 起，使用者提供的 resolve.conditions 會整組取代預設值，升級時不要隨手加。
if (process.env.NODE_ENV === "production") {
  process.env.NODE_ENV = "test";
}

export default defineConfig({});
