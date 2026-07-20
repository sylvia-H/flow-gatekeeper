import { Controller, Get, Header, HttpException, HttpStatus } from "@nestjs/common";
import { HealthService } from "./health.service.js";
import { aggregateHealth } from "../../lib/health-aggregate.js";
import type { DependencyProbe } from "../../lib/health-aggregate.js";

type HealthResponseBody = {
  status: "healthy" | "unhealthy";
  checkedAt: string;
  dependencies: { redis: DependencyProbe; mongo: DependencyProbe };
};

/**
 * `GET /healthz`（US2，contracts/health-endpoint.md）：**免認證**、每次請求即時探測、
 * MUST NOT 快取先前結果。二態：Redis 與 Mongo 皆 `up` → 200 `healthy`；任一 `down` →
 * 503 `unhealthy`。body 逐項列出各依賴狀態，供人工排查與容器 healthcheck 消費（FR-005/FR-006）。
 *
 * 用 `HttpException` 帶自訂 body（而非 `@Res()`）承載動態狀態碼——`getResponse()` 回傳的物件
 * 會被 Nest 原樣序列化為 JSON body，不落入預設的 `{statusCode,message,error}` 錯誤信封；
 * 藉此避免 api 需另外對 `express` 型別建立直接相依（api 現況只依賴 `@nestjs/platform-express`）。
 */
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("healthz")
  @Header("Cache-Control", "no-store")
  async check(): Promise<HealthResponseBody> {
    const dependencies = await this.health.check();
    const status = aggregateHealth(dependencies);
    const body: HealthResponseBody = {
      status,
      checkedAt: new Date().toISOString(),
      dependencies,
    };
    if (status === "unhealthy") {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return body;
  }
}
