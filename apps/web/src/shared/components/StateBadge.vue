<script setup lang="ts">
import type { MachineState } from "@flow-gatekeeper/contracts";
import { STATE_STYLE } from "../lib/state-style.js";

/**
 * 機台狀態文字徽章（正常／警告／嚴重）：卡片標頭與 AI 診斷面板閒置列共用（合併門第 2 輪 #13，原本三份 markup）。
 * 1px 邊框＋`py-px` 維持 20px 高；嚴重時底色接近卡片的 crit-bg，徽章需 `border-crit` 才分得出來，其他狀態為透明邊框。
 * 狀態不只靠顏色：一律帶文字 label。排版用的 class（例如 `shrink-0`）由呼叫端以 class 傳入、合併到根節點。
 */
withDefaults(
  defineProps<{
    state: MachineState;
    /** 是否在文字前加視覺隱藏的「狀態：」前綴（面板裡徽章不在按鈕名稱內時需要；卡片按鈕另有 aria 名稱）。 */
    srPrefix?: boolean;
  }>(),
  { srPrefix: false },
);
</script>

<template>
  <span
    class="rounded-pill border px-2 py-px text-xs font-semibold leading-4"
    :class="[
      STATE_STYLE[state].badgeText,
      STATE_STYLE[state].badgeSurface,
      state === 'critical' ? 'border-crit' : 'border-transparent',
    ]"
  ><span v-if="srPrefix" class="sr-only">狀態：</span>{{ STATE_STYLE[state].label }}</span>
</template>
