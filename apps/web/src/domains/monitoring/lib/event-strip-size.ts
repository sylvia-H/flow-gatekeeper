/**
 * 事件流面板高度（App 的 `useResizeDrag` 參數；FR-031；首屏設計的事件列約 150px 高）。
 *
 * 預設高度對齊整列：面板高 = 上下邊框 2px + 標題列 34px（`h-[34px]`，含 1px 底線）+ 每列 32px
 * （`min-h-8`，含列間 1px 線）。對不齊時最後一列會在玻璃下緣被切成半列，讀起來像被視窗切掉。
 * 數字跟著 `EventStrip.vue` 的列高走；改列高時一併改這裡（測試鎖定換算）。
 *
 * - 視窗高 > 800px：4 列（164px）。
 * - 視窗高 ≤ 800px（1366×768、1024×768）：標題 + 2 列（100px，即下限，spec FR-034c 的 100–360），
 *   把高度讓給拓樸區，第一列卡片完整入鏡。下限同樣對齊整列：差 1px 就會露出第三列的上緣
 *   （選取列的深青內框會像一條線），標題列取 34px 正是為了讓 100px 整列。
 * 只決定「沒有偏好時」的預設；使用者拖曳或方向鍵調整過的高度（`storageKey` 偏好）一律優先，
 * 仍可調到上限 360px。
 */
/** 面板外框 2px + 標題列 34px。 */
export const EVENT_STRIP_CHROME_PX = 36;
/** 每一列事件的高度。 */
export const EVENT_STRIP_ROW_PX = 32;

/** 下限：標題＋2 列（100px，spec FR-034c）。 */
export const EVENT_STRIP_MIN = 100;
export const EVENT_STRIP_MAX = 360;
export const EVENT_STRIP_STORAGE_KEY = "flow-gatekeeper:event-strip-height";
/** 視窗高不超過此值時改用矮預設。 */
export const SHORT_VIEWPORT_MAX_HEIGHT = 800;

/** 顯示 `rows` 列事件、最後一列不被切半的面板高度（夾在上下限內）。 */
export function eventStripHeightForRows(rows: number): number {
  const px = EVENT_STRIP_CHROME_PX + rows * EVENT_STRIP_ROW_PX;
  return Math.min(EVENT_STRIP_MAX, Math.max(EVENT_STRIP_MIN, px));
}

/** 依視窗高決定預設高度（未設偏好時）。 */
export function eventStripInitialHeight(viewportHeight: number): number {
  return eventStripHeightForRows(viewportHeight <= SHORT_VIEWPORT_MAX_HEIGHT ? 2 : 4);
}
