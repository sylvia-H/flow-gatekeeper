/** `withTimeout` 逾時拋出的錯誤；訊息為 `<label> timed out after <ms>ms`。 */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * 為 Redis／Mongo 這類可能卡在連線建立的操作加上時限：`work` 在 `ms` 內未結算就以 `TimeoutError` reject。
 * 結算後一律清掉計時器（不留下會延後行程結束的 timeout）。逾時不會取消底層的 `work`——它仍可能稍後完成，
 * 呼叫端須自行承擔（例如入列逾時後 add 仍可能在 Redis 恢復時寫入）。
 *
 * POST 入列（`JobsService`）與 GET 查詢（`DiagnosisLookupService`）共用。
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
