<script setup lang="ts">
import { Activity, Boxes } from "lucide-vue-next";
import AppLayout from "./shared/components/AppLayout.vue";
import { useMonitoringStore } from "./domains/monitoring/stores/monitoring.store.js";
import { KNOWN_MACHINE_IDS, machineLabel } from "./domains/monitoring/lib/machine-labels.js";

/**
 * App 根：組裝監控台外殼——第一屏即監控台（非 landing page，design-spec §1/§6）。
 * 即時連線／訂閱與 topology 於 US1（T017）接入；TopBar 於 US2（T019）填入。
 */
const store = useMonitoringStore();
</script>

<template>
  <AppLayout :connection-status="store.connectionStatus" :drawer-open="false">
    <template #sidebar>
      <div class="flex items-center gap-2 border-b border-subtle px-4 py-3">
        <Activity class="h-5 w-5 text-accent" aria-hidden="true" />
        <div class="min-w-0">
          <div class="truncate text-sm font-semibold text-fg">flow-gatekeeper</div>
          <div class="text-xs text-fg-subtle">development</div>
        </div>
      </div>
      <nav class="px-3 py-4">
        <div class="px-1 pb-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">
          Machines
        </div>
        <ul class="space-y-0.5">
          <li v-for="id in KNOWN_MACHINE_IDS" :key="id">
            <span
              class="flex items-center gap-2 rounded-control px-2 py-1.5 text-sm text-fg-muted"
            >
              <Boxes class="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
              <span class="truncate">{{ machineLabel(id) }}</span>
            </span>
          </li>
        </ul>
      </nav>
    </template>

    <template #topbar>
      <!-- TopBar 於 US2（T019）填入 -->
      <div class="text-sm text-fg-muted">flow-gatekeeper 監控台</div>
    </template>

    <template #main>
      <!-- Topology / node grid 於 US1（T016/T017）填入 -->
      <div class="flex h-full items-center justify-center p-6 text-sm text-fg-subtle">
        監控台外殼就緒；即時 topology 於 US1 接入。
      </div>
    </template>
  </AppLayout>
</template>
