<script setup lang="ts">
import { useId } from "vue";
import { ChevronDown } from "lucide-vue-next";
import StreamingPanel from "./StreamingPanel.vue";

/**
 * 原始串流的展開區塊（上方分隔線＋展開鈕＋`StreamingPanel`）：進行中、已完成、失敗三態共用
 * （合併門第 2 輪 #13，原本三份 markup）。展開狀態由呼叫端持有（`v-model:expanded`），
 * 因為各態的預設值不同（進行中／完成收合、失敗展開），且換態或換任務時要回到該態預設。
 * 收合時面板不在 DOM，展開鈕的 `aria-controls` 也就不指向它。
 */
defineProps<{
  /** 展開鈕文字（「原始串流」或失敗態的「原始串流（中斷前）」）。 */
  label: string;
  /** 累積串流文字。 */
  text: string;
  /** 是否仍在串流（決定游標）。 */
  streaming: boolean;
}>();

const expanded = defineModel<boolean>("expanded", { required: true });
const panelId = useId();

const DISCLOSURE_BTN =
  "flex w-full items-center justify-between rounded-control text-sm font-semibold text-ink-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-focus";
</script>

<template>
  <div class="border-t border-edge pt-3">
    <button
      type="button"
      :class="DISCLOSURE_BTN"
      :aria-expanded="expanded"
      :aria-controls="expanded ? panelId : undefined"
      @click="expanded = !expanded"
    >
      <span>{{ label }}</span>
      <ChevronDown
        class="h-4 w-4 transition-transform"
        :class="expanded ? 'rotate-180' : ''"
        aria-hidden="true"
      />
    </button>
    <StreamingPanel v-if="expanded" :id="panelId" class="mt-2" :text="text" :streaming="streaming" />
  </div>
</template>
