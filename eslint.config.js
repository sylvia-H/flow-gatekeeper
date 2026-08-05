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
    rules: {
      // 純排版規則交由編輯器/格式化處理，關閉以免手寫模板反覆衝突
      // （eslint-plugin-vue 官方建議：使用格式化工具時關閉 formatting rules）。
      // 保留 essential/correctness 規則（如 vue/return-in-computed-property）。
      "vue/max-attributes-per-line": "off",
      "vue/singleline-html-element-content-newline": "off",
      "vue/html-self-closing": "off",
      "vue/first-attribute-linebreak": "off",
      "vue/html-closing-bracket-newline": "off",
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
