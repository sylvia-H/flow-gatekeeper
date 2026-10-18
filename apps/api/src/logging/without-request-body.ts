/**
 * 會在 message（以及 stack 第一行）引用請求本文片段的 body-parser 錯誤類型 → 換上的固定訊息。
 *
 * 依 body-parser 2.3 原始碼（`lib/read.js`、`lib/types/*.js`）與 raw-body：
 * - `entity.parse.failed`：message 來自 parser 本身——json 是 V8 的 `JSON.parse`（例如
 *   `Unexpected token 'S', "SECRET" is not valid JSON`）或 strict 模式首字元檢查，都引用輸入片段。
 * - `entity.verify.failed`：message 來自 `verify` 回呼，內容不受控（本專案未設 verify，保守列入）。
 * - 其餘類型（`entity.too.large`、`request.aborted`、`request.size.invalid`、`stream.encoding.set`、
 *   `stream.not.readable`、`parameters.too.many`、`querystring.parse.rangeError`、`charset.unsupported`、
 *   `encoding.unsupported`）的訊息是固定字或只帶長度、上限、Content-Type／Content-Encoding 標頭值，不含本文。
 */
const BODY_QUOTING_MESSAGES: Readonly<Record<string, string>> = {
  "entity.parse.failed": "request body could not be parsed",
  "entity.verify.failed": "request body verification failed",
};

/**
 * 回傳去掉請求本文的 error 副本（沒有可去掉的內容時原樣回傳）：
 * - 自有 `body` 屬性：body-parser 解析失敗的 error 把**原始請求本文**掛在 `err.body`；pino 的標準
 *   err serializer 會複製 error 上所有可列舉屬性，記 `{ err }` 就等於把使用者送來的內容寫進日誌。
 * - 會引用本文片段的 message（見 `BODY_QUOTING_MESSAGES`）：message 換成固定字串，stack 裡的原訊息
 *   一併替換。
 * 副本保留原型（`type` 仍是原 class 名）與其餘自有屬性（含不可列舉的 `message`／`stack`），
 * 不改動呼叫端的原物件。
 */
export function withoutRequestBody<E extends Error>(err: E): E {
  const type = (err as { type?: unknown }).type;
  const fixedMessage = typeof type === "string" ? BODY_QUOTING_MESSAGES[type] : undefined;
  if (!Object.prototype.hasOwnProperty.call(err, "body") && fixedMessage === undefined) return err;

  const copy = Object.create(Object.getPrototypeOf(err) as object | null) as E;
  for (const key of Object.getOwnPropertyNames(err)) {
    if (key === "body") continue;
    const descriptor = Object.getOwnPropertyDescriptor(err, key);
    if (!descriptor) continue;
    // 一律以「從原物件讀出的值」建資料屬性：V8 的 `stack` 是綁在原 error 內部 slot 上的 accessor，
    // 直接複製 descriptor 到副本上讀出來會是空的。可列舉性照原樣。
    Object.defineProperty(copy, key, {
      value: (err as unknown as Record<string, unknown>)[key],
      writable: true,
      enumerable: descriptor.enumerable ?? false,
      configurable: true,
    });
  }
  if (fixedMessage !== undefined) {
    const original = err.message;
    Object.defineProperty(copy, "message", { value: fixedMessage, writable: true, configurable: true });
    if (typeof err.stack === "string") {
      const stack = original.length > 0 ? err.stack.split(original).join(fixedMessage) : err.stack;
      Object.defineProperty(copy, "stack", { value: stack, writable: true, configurable: true });
    }
  }
  return copy;
}
