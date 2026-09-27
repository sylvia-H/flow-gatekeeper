/**
 * 讓測試能以 vite 的 `?raw` 匯入讀取 repo 根的 `asyncapi.yaml`。
 * contracts 不依賴 `@types/node`（此套件同時被瀏覽器端匯入），故不用 `node:fs`。
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
