// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectScope, nextTick, reactive, type EffectScope } from "vue";
import {
  APP_TITLE,
  documentAlertOf,
  faviconHref,
  useDocumentAlert,
  type DocumentAlertInput,
} from "./useDocumentAlert.js";

const iconLink = (): HTMLLinkElement | null => document.querySelector<HTMLLinkElement>('link[rel~="icon"]');

describe("documentAlertOf", () => {
  const base: DocumentAlertInput = { critical: 0, connection: "connected", everConnected: true };

  it("連線正常、無嚴重：產品名與基礎 favicon", () => {
    expect(documentAlertOf(base)).toEqual({ title: APP_TITLE, icon: "normal" });
  });

  it("嚴重 N > 0：「● 嚴重 N · flow-gatekeeper」與嚴重版 favicon", () => {
    expect(documentAlertOf({ ...base, critical: 1 })).toEqual({ title: "● 嚴重 1 · flow-gatekeeper", icon: "critical" });
    expect(documentAlertOf({ ...base, critical: 3 }).title).toBe("● 嚴重 3 · flow-gatekeeper");
  });

  it("曾連上後重新連線中／已斷線：離線標示蓋過嚴重（與橫幅優先序同向），文字與連線 chip 一致", () => {
    expect(documentAlertOf({ ...base, critical: 2, connection: "reconnecting" })).toEqual({
      title: "○ 重新連線中 · flow-gatekeeper",
      icon: "offline",
    });
    expect(documentAlertOf({ ...base, connection: "disconnected" })).toEqual({
      title: "○ 已斷線 · flow-gatekeeper",
      icon: "offline",
    });
  });

  it("首次連線中（從未連上）不標離線，與橫幅的中性「連線中…」一致", () => {
    expect(documentAlertOf({ critical: 0, connection: "disconnected", everConnected: false })).toEqual({
      title: APP_TITLE,
      icon: "normal",
    });
  });
});

describe("faviconHref", () => {
  it("依 BASE_URL 組出 public 下的三個檔名", () => {
    expect(faviconHref("normal")).toBe("/favicon.svg");
    expect(faviconHref("critical")).toBe("/favicon-critical.svg");
    expect(faviconHref("offline", "/app/")).toBe("/app/favicon-offline.svg");
  });
});

describe("useDocumentAlert", () => {
  let scope: EffectScope | null = null;
  let input: DocumentAlertInput;

  function start(): void {
    scope = effectScope();
    scope.run(() => {
      useDocumentAlert(() => ({ ...input }));
    });
  }

  beforeEach(() => {
    document.title = "原始標題";
    document.head.querySelectorAll('link[rel~="icon"]').forEach((el) => el.remove());
    input = reactive<DocumentAlertInput>({ critical: 0, connection: "connected", everConnected: true });
  });

  afterEach(() => {
    scope?.stop();
    scope = null;
    document.head.querySelectorAll('link[rel~="icon"]').forEach((el) => el.remove());
  });

  it("掛上即寫入目前狀態；嚴重數變化 → 標題與 href 跟著換；回 0 → 還原產品名與基礎 favicon", async () => {
    const link = document.createElement("link");
    link.rel = "icon";
    link.setAttribute("href", "/favicon.svg");
    document.head.appendChild(link);

    start();
    expect(document.title).toBe(APP_TITLE);
    expect(link.getAttribute("href")).toBe("/favicon.svg");

    input.critical = 2;
    await nextTick();
    expect(document.title).toBe("● 嚴重 2 · flow-gatekeeper");
    expect(link.getAttribute("href")).toBe("/favicon-critical.svg");

    input.critical = 1;
    await nextTick();
    expect(document.title).toBe("● 嚴重 1 · flow-gatekeeper");
    expect(link.getAttribute("href")).toBe("/favicon-critical.svg");

    input.critical = 0;
    await nextTick();
    expect(document.title).toBe(APP_TITLE);
    expect(link.getAttribute("href")).toBe("/favicon.svg");
  });

  it("斷線 → 離線標題與離線 favicon；重連 → 回到依嚴重數決定", async () => {
    input.critical = 1;
    start();
    input.connection = "reconnecting";
    await nextTick();
    expect(document.title).toBe("○ 重新連線中 · flow-gatekeeper");
    expect(iconLink()?.getAttribute("href")).toBe("/favicon-offline.svg");

    input.connection = "connected";
    await nextTick();
    expect(document.title).toBe("● 嚴重 1 · flow-gatekeeper");
    expect(iconLink()?.getAttribute("href")).toBe("/favicon-critical.svg");
  });

  it("衍生值不變時不重寫 DOM（來源每秒或每幀重算也不多寫）", async () => {
    input.critical = 1;
    start();
    // 外部改掉標題與 href：composable 若在每次來源重算時都寫，下面會被蓋回去。
    document.title = "外部改的";
    iconLink()?.setAttribute("href", "/外部.svg");

    // 連線中改 everConnected：來源與 `alert` 都會重算（新物件），但標題與 favicon 字串不變。
    input.everConnected = false;
    await nextTick();
    expect(document.title).toBe("外部改的");
    expect(iconLink()?.getAttribute("href")).toBe("/外部.svg");
  });

  it("沒有 <link rel=icon> 時自建；scope 結束時移除自建的 link、還原原始標題", async () => {
    expect(iconLink()).toBeNull();
    start();
    const link = iconLink();
    expect(link).not.toBeNull();
    expect(link?.getAttribute("type")).toBe("image/svg+xml");
    expect(link?.getAttribute("href")).toBe("/favicon.svg");

    input.critical = 1;
    await nextTick();
    expect(document.title).toBe("● 嚴重 1 · flow-gatekeeper");

    scope?.stop();
    scope = null;
    expect(document.title).toBe("原始標題");
    expect(iconLink()).toBeNull();
  });

  it("既有的 link：scope 結束時還原原本的 href", async () => {
    const link = document.createElement("link");
    link.rel = "icon";
    link.setAttribute("href", "/原本.svg");
    document.head.appendChild(link);

    input.critical = 1;
    start();
    expect(link.getAttribute("href")).toBe("/favicon-critical.svg");

    scope?.stop();
    scope = null;
    expect(link.getAttribute("href")).toBe("/原本.svg");
    expect(iconLink()).toBe(link);
    expect(document.title).toBe("原始標題");
  });
});
