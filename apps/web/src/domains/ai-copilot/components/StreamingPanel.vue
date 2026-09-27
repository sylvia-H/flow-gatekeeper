<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

/**
 * 串流面板（design-spec §7.7、FR-005/FR-013）：逐段 append 的 AI 推理文字 + caret。
 * 自動貼底跟隨——**僅在使用者未手動上捲時**跟隨到底；手動上捲則不強拉（FR-013）。
 * 背景 `bg-inset`、max-height 220–320px、overflow auto。
 *
 * 無障礙：刻意**不是** live region（`role="log"` 隱含 `aria-live`，會讓螢幕閱讀器逐 token 念）；
 * 串流中以 `aria-busy` 標示內容仍在變動，完成／失敗的摘要改由 CopilotDrawer 的 live region 公告。
 * `tabindex=0` 讓鍵盤使用者能聚焦後捲動長串流。
 */
const props = defineProps<{
  /** 累積串流文字。 */
  text: string;
  /** 是否仍在串流（active）——決定是否顯示閃爍 caret。 */
  streaming: boolean;
}>();

const scroller = ref<HTMLElement | null>(null);
/** 使用者是否貼在底部（未手動上捲）；初始為真。 */
let stickToBottom = true;

/** 判定是否已接近底部（容忍 24px 抖動）。 */
function updateStick(): void {
  const el = scroller.value;
  if (!el) return;
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

watch(
  () => props.text,
  async () => {
    if (!stickToBottom) return; // 手動上捲時不強拉
    await nextTick();
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);
</script>

<template>
  <div
    ref="scroller"
    class="max-h-[320px] min-h-[64px] overflow-auto rounded-control bg-inset p-3 font-mono text-xs leading-relaxed text-fg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    role="region"
    tabindex="0"
    aria-label="AI 推理串流"
    :aria-busy="streaming ? 'true' : 'false'"
    @scroll="updateStick"
  >
    <span class="whitespace-pre-wrap break-words">{{ text }}</span>
    <span
      v-if="streaming"
      class="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-accent align-middle animate-stream-caret"
      aria-hidden="true"
    />
  </div>
</template>
