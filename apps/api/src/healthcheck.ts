import { request } from "node:http";

/**
 * api 健康探針（映像第二進入點 → dist/healthcheck.js；FR-006a、009 research R4a、
 * contracts/health-endpoint.md §6）。
 *
 * **009 起改走 `GET /healthz`**，取代 008 的 `/ws` 握手式探活——舊版只證明「HTTP server
 * 在聽且 Gateway 已 attach」，不涵蓋 Redis／Mongo 連通性；`/healthz` 補上這層深度
 * （008 clarify 已明文把此端點劃歸 009）。HTTP 200 → exit 0（healthy）；其餘狀態碼／連線
 * 錯誤／逾時 → exit 1（unhealthy）。
 *
 * MUST 只用 node 內建 `http`（維持 008「healthcheck 去外部工具依賴」的收斂結論，不引入
 * wget／curl）。以 127.0.0.1 連自身容器，compose healthcheck 的 timeout 5s 為外層上限，
 * 本檔另設較短的自我逾時避免 socket 懸置。`docker-compose.yml` 的 `test` 指令不需變更
 * （仍為 `["CMD","node","dist/healthcheck.js"]`），只有本檔內容改寫。
 */
const port = Number(process.env.API_PORT ?? 3000);
const SELF_TIMEOUT_MS = 4000;

const req = request(
  { host: "127.0.0.1", port, path: "/healthz", method: "GET", timeout: SELF_TIMEOUT_MS },
  (res) => {
    res.resume(); // 消耗 body、釋放連線；狀態碼即判準，不需解析內容
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);

req.on("timeout", () => {
  req.destroy();
  process.exit(1);
});
req.on("error", () => {
  process.exit(1);
});

req.end();
