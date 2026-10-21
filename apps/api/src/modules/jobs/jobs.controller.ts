import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import type { z } from "zod";
import {
  CreateDiagnosisBodySchema,
  DiagnosisLookupParamsSchema,
  DiagnosisLookupQuerySchema,
} from "@flow-gatekeeper/contracts";
import type { CreateDiagnosisResponse, DiagnosisLookupResponse } from "@flow-gatekeeper/contracts";
import { JobsService } from "./jobs.service.js";
import { DiagnosisLookupService } from "./diagnosis-lookup.service.js";

/** controller 只需要 service 的建立能力（測試可注入 fake）。 */
export type DiagnosisCreator = Pick<JobsService, "createDiagnosis">;
/** controller 只需要 lookup service 的查詢能力（測試可注入 fake）。 */
export type DiagnosisLookup = Pick<DiagnosisLookupService, "lookup">;

/** 400 的 `issues`：只帶路徑與代碼，不回顯原始輸入。 */
function issuesOf(error: z.ZodError): { path: string; code: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join(".") || "(root)", code: issue.code }));
}

/**
 * 只接受 `application/json`（可帶 charset 等參數）。express 預設也會解析 urlencoded，而
 * form 送出屬 simple request、不觸發 CORS preflight——任何網站都能在使用者瀏覽器裡觸發診斷；
 * urlencoded 的 `machineId[$ne]=x` 還會被解析成物件。要求 JSON 等於強制跨站請求先過 preflight。
 */
function isJsonContentType(contentType: string | undefined): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * 建立診斷的 REST 入口（FR-001）。**開發階段免授權**（FR-021）；WS 訂閱仍需 `WS_AUTH_SECRET`。
 *
 * body 以契約的 `CreateDiagnosisBodySchema` 驗證後才交給 service：`socketId` 必須是 Gateway
 * 派發的 uuid、`machineId` 限 `^[a-z0-9-]{1,32}$`、`requestedBy` ≤ 64 字、`jobId`（可選的
 * idempotency key）為 uuid。這些欄位會一路進 BullMQ payload、Mongo 查詢與 LLM prompt，
 * 入口擋下型別或長度不對的輸入，下游就不必各自防禦 NoSQL 運算子注入與 prompt 灌水。
 * - Content-Type 不是 JSON → 415；body 不符契約 → 400（只回 issue 路徑與代碼，不回顯原始輸入）；
 * - machineId 不在機台名冊 → 404；佇列不可用 → 503；jobId 重複但對不上 → 409（見 JobsService）。
 */
@Controller("diagnoses")
export class JobsController {
  constructor(
    @Inject(JobsService) private readonly jobs: DiagnosisCreator,
    @Inject(DiagnosisLookupService) private readonly lookups: DiagnosisLookup,
  ) {}

  @Post()
  async create(
    @Headers("content-type") contentType: string | undefined,
    @Body() body: unknown,
  ): Promise<CreateDiagnosisResponse> {
    if (!isJsonContentType(contentType)) {
      throw new UnsupportedMediaTypeException("Content-Type 必須為 application/json");
    }
    const parsed = CreateDiagnosisBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "request body 不符合 POST /diagnoses 契約",
        issues: issuesOf(parsed.error),
      });
    }
    return this.jobs.createDiagnosis(parsed.data);
  }

  /**
   * 結果讀取與重連續接（012 US2，FR-007；contracts/diagnosis-lookup）。params／query 以契約 schema 驗證：
   * 不符 → 400（`issues` 只帶路徑與代碼、不回顯輸入；重複的 query key 被 express 解析成陣列，同樣 400）。
   * 其餘狀態碼由 `DiagnosisLookupService` 拋出：404 查無、409 `socket_unauthorized`／`job_bound_elsewhere`（body 帶
   * `code`）、503 Redis／Mongo 不可用。
   */
  @Get(":jobId")
  async lookup(@Param() params: unknown, @Query() query: unknown): Promise<DiagnosisLookupResponse> {
    const parsedParams = DiagnosisLookupParamsSchema.safeParse(params);
    const parsedQuery = DiagnosisLookupQuerySchema.safeParse(query);
    if (!parsedParams.success || !parsedQuery.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message: "request 不符合 GET /diagnoses/:jobId 契約",
        issues: [
          ...(parsedParams.success ? [] : issuesOf(parsedParams.error)),
          ...(parsedQuery.success ? [] : issuesOf(parsedQuery.error)),
        ],
      });
    }
    return this.lookups.lookup({ ...parsedQuery.data, jobId: parsedParams.data.jobId });
  }
}
