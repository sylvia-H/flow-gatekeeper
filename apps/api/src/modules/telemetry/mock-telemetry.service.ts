import { Injectable } from "@nestjs/common";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import { deriveMachineState } from "@flow-gatekeeper/shared";

/** 固定 5 台示範機台（spec Assumptions / data-model）。 */
const MACHINE_IDS = ["mixer-01", "press-02", "pack-03", "oven-04", "sorter-05"] as const;

/**
 * 決定性 mock telemetry producer（指南 §7.3 規格為單一來源）。
 *
 * 以 tick 為基底的正弦噪訊 + 週期性 warning/critical 尖峰，確保「可重播驗收」：
 * 同樣的 tick 序列產生同樣的狀態變化（press-02 critical、oven-04 warning 會週期出現）。
 * 欄位範圍與狀態門檻皆定義於此（FR-005）。
 */
@Injectable()
export class MockTelemetryService {
  private tick = 0;

  nextBatch(): TelemetryPoint[] {
    this.tick += 1;

    return MACHINE_IDS.map((machineId, index) => {
      const noise = Math.sin((this.tick + index * 7) / 12);
      const criticalSpike = this.tick % 240 > 210 && index === 1;
      const warningSpike = this.tick % 180 > 150 && index === 3;

      const temperature = 62 + noise * 8 + (criticalSpike ? 38 : warningSpike ? 18 : 0);
      const vibration =
        0.2 + Math.abs(noise) * 0.5 + (criticalSpike ? 1.8 : warningSpike ? 0.8 : 0);
      const throughput = 120 - (criticalSpike ? 45 : warningSpike ? 18 : 0) + noise * 6;
      const errorRate = criticalSpike ? 0.16 : warningSpike ? 0.06 : Math.max(0, noise * 0.01);

      // 門檻為跨端單一來源（@flow-gatekeeper/shared）；以未四捨五入值判定，避免前後端門檻漂移。
      const state: MachineState = deriveMachineState({ temperature, vibration, errorRate });

      return {
        type: "machine/data",
        machineId,
        timestamp: new Date().toISOString(),
        telemetry: {
          temperature: Number(temperature.toFixed(1)),
          vibration: Number(vibration.toFixed(2)),
          throughput: Number(throughput.toFixed(0)),
          errorRate: Number(errorRate.toFixed(3)),
        },
        state,
      };
    });
  }
}
