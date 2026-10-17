import type { Config } from 'tailwindcss';

/**
 * Tailwind token 落地 —— 視覺真實來源是 `apps/web/DESIGN.md`（013 起；token 名稱與用途見
 * `specs/013-ui-redesign/contracts/ui-contract.md` §1）。
 *
 * 顏色全部是語意名，值一律指向 `src/styles/theme.css` 的 CSS 變數（`R G B` 三元組），
 * light／dark 兩套主題共用同一組 class，切換只改 `<html data-theme>`。本檔與元件 MUST NOT
 * 出現色值數字；要改色只改 theme.css。半透明用 alpha 修飾（例：磨砂玻璃 `bg-surface/72`）。
 *
 * 注意 Tailwind 3 對未定義的 class（例如少了 fontSize.number 的 `text-number`）是靜默略過、
 * 不報錯，所以新 token 一律先在這裡定義再用。顏色名不可與 fontSize 名相同（曾有
 * `colors.base` 讓 `text-base` 同時輸出字級與顏色），也不可與 utility 修飾字撞名
 * （曾有頂層 `inset` 讓 `ring-inset` 輸出環顏色）。
 */
const v = (name: string): string => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      // 推擠式 Copilot 面板的門檻（T073 使用者裁決）：≥ 1366px 時 rail 240＋把手 6＋面板 348＋內距後，
      // 拓樸內容寬約 720px，桌面 Chrome 傳統捲軸吃 10px 後仍 710 ≥ 三欄門檻 708（3 × 220 卡片＋2 × 24 溝槽；
      // T077 面板由 360 縮為 348），開面板仍可三欄並排；低於此寬推擠會把拓樸擠成單欄
      // （1024 只剩約 372px、1280 約 622px），所以 < 1366 一律 bottom-sheet。須與 useModalSheet 的 MOBILE_QUERY 一致。
      screens: {
        desk: '1366px',
      },
      colors: {
        bench: { DEFAULT: v('bench'), grid: v('bench-grid') },
        rim: v('rim'),
        surface: { DEFAULT: v('surface'), strong: v('surface-strong') },
        edge: v('edge'),
        highlight: v('highlight'),
        ink: { DEFAULT: v('ink'), 2: v('ink-2'), 3: v('ink-3') },
        etch: v('etch'),
        accent: { DEFAULT: v('accent'), strong: v('accent-strong'), wash: v('accent-wash') },
        ok: { DEFAULT: v('ok'), fg: v('ok-fg'), bg: v('ok-bg') },
        warn: { DEFAULT: v('warn'), fg: v('warn-fg'), bg: v('warn-bg') },
        crit: { DEFAULT: v('crit'), fg: v('crit-fg'), bg: v('crit-bg') },
        stale: v('stale'),
        focus: v('focus'),
        scrim: v('scrim'),
      },
      // 磨砂玻璃的 72% 不在 Tailwind 預設 opacity 刻度（…70、75…）內；不加這一格，
      // `bg-surface/72` 會被靜默略過、不產生任何規則（回歸測試：src/styles/tailwind-tokens.test.ts）。
      opacity: {
        72: '0.72',
      },
      borderRadius: {
        control: '4px',
        card: '6px',
        // 僅 badge／pill 用，屬 FR-006 與 direction contract「圓角 ≤ 6px」的明文例外。
        pill: '999px',
      },
      boxShadow: {
        // 磨砂玻璃內側上緣 1px 高光（research R2）；不用外發光陰影。
        glass: 'inset 0 1px 0 rgb(var(--c-highlight) / 0.9)',
        // 手機 bottom-sheet：往上的一層淡影，讓 sheet 與下方內容分層。
        sheet: '0 -8px 24px rgb(var(--c-ink) / 0.18)',
        // 由上而下展開的覆蓋面板（快捷鍵說明、手機異常清單）：與 sheet 同強度、方向相反（往下投影）。
        panel: '0 8px 24px rgb(var(--c-ink) / 0.18)',
      },
      // [字級, 行高]；xs／sm 與 Tailwind 內建相同（12/16、14/20），不重複定義。
      // 最小功能性字級為 text-xs（12px，FR-005）；舊的 10px／11px 字級已退役，不再提供。
      fontSize: {
        md: ['16px', '24px'],
        lg: ['20px', '28px'],
        number: ['24px', '28px'],
        ratio: ['32px', '36px'],
      },
      fontFamily: {
        sans: [
          '"Source Sans 3"',
          '"Noto Sans TC"',
          '"PingFang TC"',
          '"Microsoft JhengHei"',
          'system-ui',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono"', '"Noto Sans TC"', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        // 嚴重卡片的脈動：只動 background-color 與 border-color——半週期時把半透明的 crit-bg 底「斟滿」
        // 成不透明、邊框由 crit 換成 crit-fg（只換色不動寬度；dark 主題底色差小，靠邊框色才看得出）。
        // 不動尺寸、不用 box-shadow 擴散（零位移的外擴陰影就是光暈）。刻意不寫 0%／100%：起訖取元素
        // 自身的底色與邊框色，hover（底已不透明）時只剩邊框在換色；選取規則另以 `animation: none` 停用
        // （見 styles/tailwind.css），選取的 accent 邊框與 accent-wash 底不被染紅。
        criticalPulse: {
          '50%': { backgroundColor: 'rgb(var(--c-crit-bg) / 1)', borderColor: 'rgb(var(--c-crit-fg) / 1)' },
        },
        streamCaret: {
          '0%, 40%': { opacity: '1' },
          '41%, 100%': { opacity: '0' },
        },
        indeterminate: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(220%)' },
        },
        // stage 連線的流動（虛線位移）；一個週期位移 24 = 虛線圖樣長度的整數倍，循環無跳格。
        flow: {
          '0%': { strokeDashoffset: '0' },
          '100%': { strokeDashoffset: '-24' },
        },
        // 卡片異常標記出現（只動 opacity 與 transform，不影響盒模型）；自半透明而非全透明起跳，出現當下即可讀。
        latchIn: {
          '0%': { opacity: '0.35', transform: 'translateY(2px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'critical-pulse': 'criticalPulse 1.2s ease-in-out infinite',
        'stream-caret': 'streamCaret 0.8s steps(1) infinite',
        indeterminate: 'indeterminate 1.2s ease-in-out infinite',
        flow: 'flow 1s linear infinite',
        'latch-in': 'latchIn 160ms cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [],
} satisfies Config;
