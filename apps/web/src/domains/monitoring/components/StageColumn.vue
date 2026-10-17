<script setup lang="ts">
import { computed } from "vue";
import type { Stage } from "../lib/stage-layout.js";

/**
 * 單一 stage 欄（research R5、FR-013／FR-015）：標頭放中文 stage 名與可見機台數，其下是機台卡片。
 * 卡片由呼叫端以預設 slot 傳入（本元件不依賴 store，可單獨掛載測試）。
 *
 * - 欄本身不再包一片玻璃：卡片已是玻璃片，外層再疊一層會變成卡片套卡片；欄位以標頭下緣的
 *   蝕刻線界定，卡片直接放在桌面上（對照草圖 assigned.html 的 stage 欄）。
 * - 標題只用中文、不附英文副標（FR-038）。手機（< md）升到 Heading 16px、md+ 維持 14px：手機單欄堆疊時
 *   stage 標題是區段邊界，與 14px 內文同大會讓階梯太平（critique 2026-10-16 P2）；桌機三欄並排靠字重與下緣線即可。
 * - 搜尋清空本欄時欄位保留並顯示空狀態（FR-015）：虛線框的最小高度與卡片的 min-h 相同（148px），
 *   欄寬由外層 grid 決定，空欄不塌陷。
 */
const props = defineProps<{ stage: Stage }>();

const count = computed(() => props.stage.machineIds.length);
</script>

<template>
  <section
    class="flex min-w-0 flex-col gap-3"
    role="region"
    :aria-label="stage.label"
    data-fg="stage"
    :data-stage="stage.key"
  >
    <header class="flex items-baseline justify-between gap-2 border-b border-edge px-1 pb-1.5">
      <h2 class="truncate text-md font-semibold text-ink md:text-sm">{{ stage.label }}</h2>
      <span class="shrink-0 font-mono text-xs tabular-nums text-ink-3">{{ count }} 台</span>
    </header>
    <div v-if="count > 0" class="flex flex-col gap-3">
      <slot />
    </div>
    <p
      v-else
      class="flex min-h-[148px] items-center justify-center rounded-card border border-dashed border-edge px-3.5 text-center text-xs text-ink-3"
    >
      此階段無符合的機台
    </p>
  </section>
</template>
