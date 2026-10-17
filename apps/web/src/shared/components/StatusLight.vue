<script setup lang="ts">
import { computed } from "vue";
import type { MachineState } from "@flow-gatekeeper/contracts";
import { STATE_STYLE } from "../lib/state-style.js";

const props = defineProps<{
  state: MachineState;
}>();

/** 狀態 → 語意色 token 與中文 label 皆取自共用 STATE_STYLE（顏色＋文字＋可讀名稱，FR-004）。 */
const dotClass = computed(() => STATE_STYLE[props.state].dot);
const label = computed(() => STATE_STYLE[props.state].label);
</script>

<template>
  <!-- 固定 12px 方框置中承載 10px 圓點；燈本身不動效（嚴重卡片的脈動在卡片底色，見 card-style.ts） -->
  <span
    class="inline-flex h-3 w-3 shrink-0 items-center justify-center"
    role="img"
    :aria-label="`狀態：${label}`"
  >
    <span class="block h-2.5 w-2.5 rounded-pill" :class="dotClass" />
  </span>
</template>
