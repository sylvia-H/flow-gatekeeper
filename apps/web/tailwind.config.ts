import type { Config } from 'tailwindcss';

/**
 * Tailwind token 落地 —— 唯一真實來源是 `apps/web/design/design-spec.md` §5。
 * 這裡的 theme.extend MUST 與 design-spec §4/§5 逐項一致（v0.4）；要改色票
 * 先改 design-spec，再同步這裡，不在元件內散落 hex。
 */
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        base: '#0B1014',
        surface: {
          DEFAULT: '#111820',
          hover: '#141D27',
        },
        elevated: '#17212B',
        inset: '#0E151B',
        subtle: '#26323D',
        strong: '#3E5266',
        fg: '#E7EDF2',
        'fg-muted': '#9AA8B5',
        'fg-subtle': '#687684',
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
