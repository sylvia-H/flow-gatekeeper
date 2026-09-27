<script setup lang="ts">
import { computed } from "vue";
import { useMonitoringStore } from "../stores/monitoring.store.js";
import { useDiagnoseTrigger } from "../../ai-copilot/composables/useDiagnoseTrigger.js";
import { isStale } from "../lib/stale.js";
import MachineNodeCard from "./MachineNodeCard.vue";

/**
 * Topology node grid（design-spec §6.3）。
 * **渲染來源為 store.visibleMachineIds**（固定名冊經 US4 search 過濾）——逐台向 store 查快照，
 * 無則傳 machine=null，確保冷啟動即顯示 placeholder（FR-024）；查無相符時顯示空狀態（FR-015）。
 * stale 與相對時間依 store.staleNow（每秒 tick；Pause 且連線中時凍結，見 `staleClock`）。
 */
const store = useMonitoringStore();
const trigger = useDiagnoseTrigger();

const nodes = computed(() =>
  store.visibleMachineIds.map((id) => {
    const machine = store.machines.get(id) ?? null;
    return {
      id,
      machine,
      selected: store.selectedMachineId === id,
      stale: machine ? isStale(machine.lastUpdated, store.staleNow) : false,
    };
  }),
);

function onSelect(machineId: string): void {
  store.selectMachine(machineId);
}

/** 卡片 diagnose icon：選取該台並觸發診斷（去重／連線把關在共用入口與 copilot store）。 */
function onDiagnose(machineId: string): void {
  trigger.diagnose(machineId);
}
</script>

<template>
  <div class="topology-bg h-full overflow-auto bg-surface-inset p-4 md:p-6">
    <!-- search 查無相符：空狀態（非破版空白，FR-015／Edge Cases） -->
    <div
      v-if="nodes.length === 0"
      class="flex h-full items-center justify-center text-sm text-fg-subtle"
    >
      無符合「{{ store.searchQuery }}」的機台。
    </div>

    <!-- 桌面自適應多欄；窄螢幕（mobile）以 min(100%,…) 自然退化為單欄，不溢出（FR-020/026、SC-004） -->
    <div
      v-else
      class="grid gap-4"
      style="grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr))"
    >
      <MachineNodeCard
        v-for="node in nodes"
        :key="node.id"
        :machine-id="node.id"
        :machine="node.machine"
        :selected="node.selected"
        :stale="node.stale"
        :now="store.staleNow"
        @select="onSelect"
        @diagnose="onDiagnose"
      />
    </div>
  </div>
</template>

<style scoped>
/* design-spec §6.3 grid overlay（底色用 bg-surface-inset token，僅格線走 spec 定義的疊圖） */
.topology-bg {
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: 24px 24px;
}
</style>
