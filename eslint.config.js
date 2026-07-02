// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/build/**", "**/coverage/**", "**/node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  // Vue SFC（.vue）：以 vue-eslint-parser 解析模板，`<script lang="ts">` 交給 TS parser（research R4）。
  ...pluginVue.configs["flat/recommended"],
  {
    files: ["**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    // TS 與 Vue 共用規則；.vue 的 no-explicit-any 需在此顯式登記 plugin 才生效。
    files: ["**/*.ts", "**/*.tsx", "**/*.vue"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      // 落實憲章「避免 any 擴散」：明確 any 視為錯誤
      "@typescript-eslint/no-explicit-any": "error",
      // _ 前綴與 rest 解構省略（如 const { x: _omit, ...rest }）視為刻意忽略
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
