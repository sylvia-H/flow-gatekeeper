import "dotenv/config";
import { MongoClient } from "mongodb";

/**
 * 可重播的維修紀錄 seed（FR-013）。先 deleteMany 再 insertMany，確保結果決定性、可重跑。
 * 以 tsx 執行：`pnpm --filter @flow-gatekeeper/api seed`。
 *
 * 一次性 CLI 腳本，依 Feature 009 FR-004／SC-001 範圍界定不納入結構化日誌、維持人類可讀
 * `console.log` 輸出（`specs/009-observability-baseline/contracts/log-fields.md §8`）。
 */
const url = process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/flow-gatekeeper";
const dbName = process.env.MONGO_DB ?? "flow-gatekeeper";

const client = new MongoClient(url);
await client.connect();
const db = client.db(dbName);

await db.collection("maintenanceRecords").deleteMany({});
await db.collection("maintenanceRecords").insertMany([
  {
    machineId: "press-02",
    performedAt: new Date(Date.now() - 1000 * 60 * 60 * 4),
    summary: "Replaced vibration damper. Operator noted mild overheating after restart.",
  },
  {
    machineId: "oven-04",
    performedAt: new Date(Date.now() - 1000 * 60 * 60 * 18),
    summary: "Temperature sensor calibration completed.",
  },
]);

await client.close();
console.log("seeded maintenanceRecords");
