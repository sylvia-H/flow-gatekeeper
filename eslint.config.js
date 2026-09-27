// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";

/** 需要型別資訊的檔案：TS 原始碼與 Vue SFC 的 `<script lang="ts">`。 */
const TYPED_FILES = ["**/*.ts", "**/*.tsx", "**/*.vue"];

/** 測試檔：mock／spy 寫法與 production 程式碼不同，部分 type-aware 規則在此放寬。 */
const TEST_FILES = ["**/*.test.ts", "**/*.spec.ts"];

/** 共用的 socket.io 禁令：即時通道一律原生 ws（CLAUDE.md 工程硬規則 2、docs/adr-001-native-websocket.md）。 */
const SOCKET_IO_BAN = [
  {
    name: "socket.io",
    message:
      "即時通道一律用原生 ws，不得用 Socket.IO（CLAUDE.md 工程硬規則 2；docs/adr-001-native-websocket.md）。",
  },
  {
    name: "socket.io-client",
    message:
      "前端一律用瀏覽器原生 `new WebSocket()`，Socket.IO 協定與後端 ws 不相容（CLAUDE.md 工程硬規則 2；docs/adr-001-native-websocket.md）。",
  },
];

export default tseslint.config(
  {
    // 各套件 lint script 為 `eslint .`（連設定檔一起 lint），產物與相依一律排除。
    // apps/web/design/refs/_sources 是設計稿匯出的參考腳本（design-spec 真實來源的附件），不是產品程式碼。
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.vite/**",
      "apps/web/design/refs/**",
    ],
  },
  eslint.configs.recommended,
  // type-aware 規則只套在 TS／Vue；純 JS 設定檔（eslint.config.js、postcss.config.js）不進 TS program。
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: TYPED_FILES })),
  // Vue SFC（.vue）：以 vue-eslint-parser 解析模板，`<script lang="ts">` 交給 TS parser（research R4）。
  ...pluginVue.configs["flat/recommended"],
  {
    files: TYPED_FILES,
    languageOptions: {
      parserOptions: {
        // 以 TS project service 為每個檔案找最近的 tsconfig.json；各套件 tsconfig 只 include src，
        // 套件根目錄的 *.config.ts 不在任何 program 內，改用 default project（以 base 的編譯選項）處理。
        projectService: {
          allowDefaultProject: ["apps/*/vite.config.ts", "apps/*/vitest.config.ts", "apps/*/tailwind.config.ts"],
          defaultProject: "tsconfig.base.json",
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".vue"],
      },
    },
  },
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
    files: TYPED_FILES,
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
      // Redis／BullMQ／ws／Mongo 大量非同步呼叫：漏 await 的 promise 一旦 reject 就是未處理錯誤
      // （Node 預設直接讓 process 崩潰）。刻意 fire-and-forget 必須寫 `void` 並自帶 `.catch`。
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      // 轉傳既有的 rejection reason（AbortSignal.reason、catch 到的 unknown）是刻意保留原錯誤，
      // 不該為了 lint 包成新的 Error 而丟失原型別／堆疊；仍禁止 reject 字串等明確非 Error 的字面值。
      "@typescript-eslint/prefer-promise-reject-errors": [
        "error",
        { allowThrowingAny: true, allowThrowingUnknown: true },
      ],
    },
  },
  {
    files: TEST_FILES,
    rules: {
      // `expect(obj.method).toHaveBeenCalled()` 會被誤判為 unbound method 參照。
      "@typescript-eslint/unbound-method": "off",
      // 測試常以 `as unknown as Foo` 組 fake 物件、以 any-ish 的 mock.calls 取參數。
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // fake 實作常只為了符合 async 介面而宣告 async、內部不 await。
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // 純 JS 設定檔（ESM、Node 執行）：無型別資訊。type-aware 規則只登記在 TYPED_FILES，
    // 這裡不必（也不能）再引用 @typescript-eslint 規則關閉。
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    languageOptions: {
      sourceType: "module",
    },
  },

  // ── 架構邊界（原本只靠註解維持，改由 lint 強制）──────────────────────────────
  {
    files: ["apps/web/src/**/*.ts", "apps/web/src/**/*.vue"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...SOCKET_IO_BAN,
            {
              name: "pino",
              message:
                "pino 是 Node-only 的結構化 logger，不得進瀏覽器 bundle（packages/shared/src/index.ts 註解；research R10）。",
            },
            {
              name: "@flow-gatekeeper/shared/logging",
              message:
                "shared/logging 是 Node-only（依賴 pino），web 只能匯入 `@flow-gatekeeper/shared` 根 export（research R10）。",
            },
          ],
        },
      ],
      // no-restricted-imports 不檢查動態 import()：以 AST 選擇器補上同一組禁令。
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^(pino|socket\\.io)/]",
          message:
            "web 不得動態匯入 pino／Socket.IO：pino 是 Node-only（research R10）；即時通道一律原生 WebSocket（CLAUDE.md 工程硬規則 2；docs/adr-001-native-websocket.md）。",
        },
      ],
    },
  },
  {
    files: ["apps/worker/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...SOCKET_IO_BAN,
            {
              name: "ws",
              message:
                "worker 不得直接 emit WebSocket：AI token 走 Redis Pub/Sub `ai-stream:<jobId>` → Gateway 轉發（CLAUDE.md 工程硬規則 3）。",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/api/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: SOCKET_IO_BAN }],
    },
  },
  {
    // shared 根 export 是瀏覽器可用的；logging（pino）只能經子路徑 `@flow-gatekeeper/shared/logging` 取得。
    // 非 logging 模組一旦 import／re-export ./logging，pino 就會經 web 的 `@flow-gatekeeper/shared` 被拉進 bundle。
    files: ["packages/shared/src/**/*.ts"],
    ignores: ["packages/shared/src/logging/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)logging(/|\\.js$|$)",
              message:
                "shared 非 logging 模組不得匯入／re-export ./logging：根 export 會被 web 匯入，pino 會進瀏覽器 bundle（research R10）。",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportAllDeclaration[source.value=/logging/]",
          message: "shared 根 export MUST NOT re-export ./logging（pino 會進瀏覽器 bundle；research R10）。",
        },
        {
          selector: "ExportNamedDeclaration[source.value=/logging/]",
          message: "shared 根 export MUST NOT re-export ./logging（pino 會進瀏覽器 bundle；research R10）。",
        },
      ],
    },
  },
);
