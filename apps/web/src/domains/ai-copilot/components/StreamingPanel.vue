<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";

/**
 * 原始串流面板（FR-005/FR-013；013 視覺層與繁中文案）：逐段 append 的 AI 推理文字 + 游標。
 * 自動貼底跟隨——**僅在使用者未手動上捲時**跟隨到底；手動上捲則不強拉（FR-013）。
 * 底色用 `bg-bench`（面板裡露出的桌面），max-height 320px、overflow auto；
 * 游標 `animate-stream-caret` 在 reduced-motion 下由 tailwind.css 停止。
 *
 * 無障礙：刻意**不是** live region（`role="log"` 隱含 `aria-live`，會讓螢幕閱讀器逐 token 念）；
 * 串流中以 `aria-busy` 標示內容仍在變動，完成／失敗的摘要改由 CopilotDrawer 的 live region 公告。
 * `tabindex=0` 讓鍵盤使用者能聚焦後捲動長串流。
 */
const props = defineProps<{
  /** 累積串流文字。 */
  text: string;
  /** 是否仍在串流（active）——決定是否顯示閃爍游標。 */
  streaming: boolean;
}>();

const scroller = ref<HTMLElement | null>(null);
/** 使用者是否貼在底部（未手動上捲）；初始為真。 */
let stickToBottom = true;
/** 程式最後一次貼底後的實際 scrollTop（瀏覽器會夾值，故寫入後讀回）；尚未寫過為 null。 */
let lastAutoScrollTop: number | null = null;

/**
 * scroll 事件：判定使用者是否上捲（容忍 24px 抖動）。
 *
 * 不能只看「離底距離」：程式在第 N 幀寫入 scrollTop，這次捲動的 scroll 事件要到第 N+1 幀的 scroll steps
 * 才派發（排在 rAF 之前），期間新 token 已讓內容長高——讀到的是新的 scrollHeight、舊的 scrollTop，
 * 內容長高 ≥ 24px 就會被誤判成上捲而永久停止跟隨（合併門第 2 輪 #1，rAF 合併引入的回歸）。
 * 所以不在底部時，只有 scrollTop 比程式上次捲到的位置更上面，才算使用者上捲；
 * 在底部（含內容縮短、瀏覽器把 scrollTop 夾小的情況）一律恢復跟隨。
 */
function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) {
    stickToBottom = true;
    return;
  }
  // 程式還沒捲過（剛展開、尚未收到新 token）：沒有可比的位置，不在底部即視為使用者自行捲動。
  // 1px 容忍：高 DPI 下 scrollTop 可能是小數，讀回值與實際位置有次像素差。
  if (lastAutoScrollTop === null || el.scrollTop < lastAutoScrollTop - 1) stickToBottom = false;
}

/**
 * 貼底捲動以 requestAnimationFrame 合併（WEB-17、硬規則 1 的同一精神）：token 一則一則經不同的
 * WebSocket message 抵達，若每則都 `nextTick` 後讀 scrollHeight、寫 scrollTop，每個 token 都會逼一次
 * 同步 layout。改成一幀至多一次：已有排程就不再排，到幀時 DOM 已含這一幀內累積的全部文字。
 */
let scrollFrame: number | null = null;

function scrollToBottom(): void {
  scrollFrame = null;
  if (!stickToBottom) return; // 排程後使用者才上捲：尊重上捲，不強拉
  const el = scroller.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  lastAutoScrollTop = el.scrollTop;
}

watch(
  () => props.text,
  () => {
    if (!stickToBottom || scrollFrame !== null) return; // 手動上捲時不強拉；同一幀已排程則合併
    scrollFrame = requestAnimationFrame(scrollToBottom);
  },
);

onBeforeUnmount(() => {
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
  scrollFrame = null;
});
</script>

<template>
  <div
    ref="scroller"
    class="max-h-[320px] min-h-[64px] overflow-auto rounded-control border border-edge bg-bench px-3 py-2.5 font-mono text-xs leading-relaxed text-ink-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    role="region"
    tabindex="0"
    aria-label="原始串流"
    :aria-busy="streaming ? 'true' : 'false'"
    @scroll="onScroll"
  >
    <span class="whitespace-pre-wrap break-words">{{ text }}</span>
    <span
      v-if="streaming"
      class="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-accent align-middle animate-stream-caret"
      aria-hidden="true"
    />
  </div>
</template>
