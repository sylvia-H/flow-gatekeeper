/**
 * `.vue` 模組的型別宣告。
 *
 * vue-tsc（typecheck／build）本身就能解析 SFC，這個宣告對它只是不會用到的後備；需要它的是
 * type-aware ESLint——typescript-eslint 的 project service 用的是原生 TS，看不懂 `.vue`，
 * 沒有這個宣告時 `import App from "./App.vue"` 會被推成 error type，觸發 no-unsafe-* 誤報。
 * 代價：vue-tsc 不再對不存在的 `.vue` 路徑報 TS2307，由 vite build／vitest 解析階段把關。
 */
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent;
  export default component;
}
