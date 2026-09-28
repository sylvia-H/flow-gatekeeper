import type { Config } from 'tailwindcss';

/**
 * Tailwind token 落地 —— 唯一真實來源是 `apps/web/design/design-spec.md` §5。
 * 這裡的 theme.extend MUST 與 design-spec §4/§5 逐項一致（v0.5）；要改色票
 * 先改 design-spec，再同步這裡，不在元件內散落 hex。
 *
 * 注意 Tailwind 3 對未定義的 class（例如少了 fontSize.number 的 `text-number`）是靜默略過、
 * 不報錯，所以新 token 一律先在這裡定義再用。顏色名不可與 fontSize 名相同（曾有
 * `colors.base` 讓 `text-base` 同時輸出字級與顏色），底色因此命名為 `canvas`；
 * 同理顏色名也不可與 utility 修飾字撞名（`ring-inset`），內嵌面因此是 `surface.inset`。
 */
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        canvas: '#0B1014',
        surface: {
          DEFAULT: '#111820',
          hover: '#141D27',
          // 內嵌面（輸入框、串流面板、拓樸畫布底）→ `bg-surface-inset`。不可命名為頂層 `inset`：
          // 會與內建 `ring-inset` 撞名，讓它輸出「環顏色」而非 `--tw-ring-inset: inset`。
          inset: '#0E151B',
        },
        elevated: '#17212B',
        subtle: '#26323D',
        strong: '#3E5266',
        fg: '#E7EDF2',
        'fg-muted': '#9AA8B5',
        // 對 surface 5.06:1、對 elevated 4.61:1（AA）；原 #687684 對 surface 僅 3.84:1。
        'fg-subtle': '#7C8A98',
        accent: {
          DEFAULT: '#4FA3FF',
          hover: '#76B8FF',
          bg: '#102A42',
          'bg-strong': '#143A5C',
          wash: '#0F1B28',
        },
        ok: {
          DEFAULT: '#37C978',
          fg: '#9DF0BF',
          border: '#1E5C38',
          bg: '#123522',
        },
        warn: {
          DEFAULT: '#F2B84B',
          fg: '#F2CF85',
          border: '#6B5220',
          bg: '#3A2B12',
        },
        crit: {
          DEFAULT: '#FF5C66',
          fg: '#FF9AA0',
          border: '#7A2A30',
          bg: '#3B151A',
        },
      },
      borderRadius: {
        card: '8px',
        control: '6px',
        pill: '999px',
      },
      boxShadow: {
        card: '0 1px 0 rgba(255,255,255,0.04), 0 12px 28px rgba(0,0,0,0.22)',
        drawer: '-18px 0 36px rgba(0,0,0,0.35)',
      },
      // [字級, 行高]；xs／sm 與 Tailwind 內建相同（12/16、14/20），不重複定義。
      fontSize: {
        '2xs': ['10px', '14px'],
        pill: ['11px', '16px'],
        md: ['16px', '24px'],
        lg: ['20px', '28px'],
        number: ['22px', '28px'],
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        criticalPulse: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(255,92,102,0.35)' },
          '50%': { boxShadow: '0 0 0 6px rgba(255,92,102,0)' },
        },
        streamCaret: {
          '0%, 40%': { opacity: '1' },
          '41%, 100%': { opacity: '0' },
        },
        indeterminate: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(220%)' },
        },
      },
      animation: {
        'critical-pulse': 'criticalPulse 1.2s ease-in-out infinite',
        'stream-caret': 'streamCaret 0.8s steps(1) infinite',
        indeterminate: 'indeterminate 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
