<script setup lang="ts">
import { computed } from "vue";
import { useMonitoringStore } from "../stores/monitoring.store.js";
import { useCopilotStore } from "../../ai-copilot/stores/copilot.store.js";
import { KNOWN_MACHINE_IDS } from "../lib/machine-labels.js";
import { isStale } from "../lib/stale.js";
import MachineNodeCard from "./MachineNodeCard.vue";

/**
 * Topology node grid（design-spec §6.3）。
 * **渲染來源為固定名冊 KNOWN_MACHINE_IDS**（非 machineList getter）——逐台向 store 查快照，
 * 無則傳 machine=null，確保冷啟動即顯示 5 張 placeholder（FR-024）。
 * stale 依 store.now（每秒 tick）重算（FR-017）。
 */
const store = useMonitoringStore();
const copilot = useCopilotStore();

const nodes = computed(() =>
  KNOWN_MACHINE_IDS.map((id) => {
    const machine = store.machines.get(id) ?? null;
    return {
      id,
      machine,
      selected: store.selectedMachineId === id,
      stale: machine ? isStale(machine.lastUpdated, store.now) : false,
    };
  }),
);

function onSelect(machineId: string): void {
  store.selectMachine(machineId);
}

/** 卡片 diagnose icon：選取該台並觸發診斷（store 內部去重／連線把關）。 */
function onDiagnose(machineId: string): void {
  store.selectMachine(machineId);
  void copilot.diagnose(machineId, store.clientId);
}
</script>

<template>
  <div class="topology-bg h-full overflow-auto bg-inset p-4 md:p-6">
    <!-- 桌面自適應多欄；窄螢幕（mobile）以 min(100%,…) 自然退化為單欄，不溢出（FR-020/026、SC-004） -->
    <div
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
        :now="store.now"
        @select="onSelect"
        @diagnose="onDiagnose"
      />
    </div>
  </div>
</template>

<style scoped>
/* design-spec §6.3 grid overlay（底色用 bg-inset token，僅格線走 spec 定義的疊圖） */
.topology-bg {
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: 24px 24px;
}
</style>
