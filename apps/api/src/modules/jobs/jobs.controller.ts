import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import { JobsService } from "./jobs.service.js";
import type { CreateDiagnosisResult } from "./jobs.service.js";

/** POST /diagnoses 的 request body（`socketId` 即 WS clientId；純後端 smoke 可填任意字串）。 */
type CreateDiagnosisBody = {
  machineId?: string;
  requestedBy?: string;
  socketId?: string;
};

/**
 * 建立診斷的 REST 入口（FR-001）。**開發階段免授權**（FR-021）；WS 訂閱仍需 `WS_AUTH_SECRET`。
 * 缺必要欄位（`machineId`／`socketId`）時安全拒絕（400），不建任務、不崩潰（spec Edge Cases）。
 */
@Controller("diagnoses")
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  async create(@Body() body: CreateDiagnosisBody): Promise<CreateDiagnosisResult> {
    if (!body?.machineId || !body?.socketId) {
      throw new BadRequestException("machineId 與 socketId 為必填");
    }
    return this.jobs.createDiagnosis(body.machineId, body.requestedBy, body.socketId);
  }
}
