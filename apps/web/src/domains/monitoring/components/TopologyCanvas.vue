<script setup lang="ts">
import { useMonitoringStore } from "../stores/monitoring.store.js";
import { KNOWN_MACHINE_IDS } from "../lib/machine-labels.js";
import MachineNodeCard from "./MachineNodeCard.vue";

/**
 * Topology node grid（design-spec §6.3）。
 * **渲染來源為固定名冊 KNOWN_MACHINE_IDS**（非 machineList getter）——逐台向 store 查快照，
 * 無則傳 machine=null，確保冷啟動即顯示 5 張 placeholder（FR-024）。
 * stale 視覺於 US3（T023）接入。
 */
const store = useMonitoringStore();

function onSelect(machineId: string): void {
  store.selectMachine(machineId);
}
</script>

<template>
  <div class="topology-bg h-full overflow-auto bg-inset p-4 md:p-6">
    <div
      class="grid gap-4"
      style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))"
    >
      <MachineNodeCard
        v-for="id in KNOWN_MACHINE_IDS"
        :key="id"
        :machine-id="id"
        :machine="store.machines.get(id) ?? null"
        :selected="store.selectedMachineId === id"
        :stale="false"
        @select="onSelect"
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
