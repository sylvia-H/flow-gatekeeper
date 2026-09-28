import { MongoClient } from "mongodb";
import { loadApiDotenv } from "../lib/env-file.js";
import { parseApiEnv } from "../lib/env-schema.js";

/**
 * 可重播的維修紀錄 seed（FR-013）。先 deleteMany 再 insertMany，確保結果決定性、可重跑。
 * 以 tsx 執行：`pnpm --filter @flow-gatekeeper/api seed`。
 *
 * 一次性 CLI 腳本，依 Feature 009 FR-004／SC-001 範圍界定不納入結構化日誌、維持人類可讀
 * `console.log` 輸出（`specs/009-observability-baseline/contracts/log-fields.md §8`）。
 */
// 與 main.ts 同一個 .env 載入點（apps/api/.env，不依賴 cwd）與同一份 schema：與 api 本體同一套驗證，
// env 不合法即中止（即使不合法的是 seed 用不到的變數——那份 env api 本身也會拒絕啟動）；留空套用預設。
// 不再各自 `process.env.X ?? 預設`（`??` 對空字串不生效）。
loadApiDotenv();
const { MONGO_URL: url, MONGO_DB: dbName } = parseApiEnv(process.env);

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
