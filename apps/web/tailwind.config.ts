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
        criticalPulse: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgb(var(--c-crit) / 0.35)' },
          '50%': { boxShadow: '0 0 0 6px rgb(var(--c-crit) / 0)' },
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
      },
      animation: {
        'critical-pulse': 'criticalPulse 1.2s ease-in-out infinite',
        'stream-caret': 'streamCaret 0.8s steps(1) infinite',
        indeterminate: 'indeterminate 1.2s ease-in-out infinite',
        flow: 'flow 1s linear infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
