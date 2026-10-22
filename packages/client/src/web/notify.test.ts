/**
 * 通知的纯逻辑：角标、要不要弹、文案、环境探测与真弹出。
 *
 * 这几条坏了都不会报错：要么该提醒时没提醒（人切走了就忘了），
 * 要么刷新页面把旧挂起重弹一遍（把提醒变成噪音）。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  approvalNotification,
  detectNotifications,
  doneNotification,
  notificationButtonTitle,
  shouldNotifyApproval,
  shouldNotifyRunDone,
  showSystemNotification,
  titleFor,
} from "./notify";

class FakeNotification {
  static permission: string | undefined = "granted";
  static created: FakeNotification[] = [];
  title: string;
  options: { body?: string; tag?: string } | undefined;
  onclick: (() => void) | null = null;
  constructor(title: string, options?: { body?: string; tag?: string }) {
    this.title = title;
    this.options = options;
    FakeNotification.created.push(this);
  }
}

afterEach(() => {
  delete (globalThis as { Notification?: unknown }).Notification;
  FakeNotification.created = [];
  FakeNotification.permission = "granted";
});

describe("titleFor", () => {
  it("没有待裁决时用原始标题，有时把数量放在前面", () => {
    assert.strictEqual(titleFor(0), "mini-pi");
    assert.strictEqual(titleFor(2), "(2) mini-pi");
  });
});

describe("要不要提醒", () => {
  it("挂起：正在看这个 Run 且前台时不弹；切走或切后台要弹", () => {
    assert.strictEqual(shouldNotifyApproval("run_1", "run_1", false), false);
    assert.strictEqual(shouldNotifyApproval("run_1", "run_1", true), true);
    assert.strictEqual(shouldNotifyApproval("run_2", "run_1", false), true);
    assert.strictEqual(shouldNotifyApproval(null, "run_1", false), true);
  });

  it("结束：自己取消的不提醒；正在看的 Run 且前台不提醒", () => {
    assert.strictEqual(shouldNotifyRunDone(null, "run_1", false, "cancelled"), false);
    assert.strictEqual(shouldNotifyRunDone("run_1", "run_1", false, "done"), false);
    assert.strictEqual(shouldNotifyRunDone("run_1", "run_1", true, "failed"), true);
    assert.strictEqual(shouldNotifyRunDone("run_2", "run_1", false, "done"), true);
  });
});

describe("通知文案", () => {
  it("挂起带任务标题与工具名，tag 按审批 id 去重", () => {
    const text = approvalNotification({ approvalId: "ap_1", runTitle: "写文档", toolName: "write_file" });
    assert.match(text.title, /裁决/);
    assert.match(text.body, /写文档/);
    assert.match(text.body, /write_file/);
    assert.strictEqual(text.tag, "ap:ap_1");
  });

  it("结束区分完成 / 失败，tag 按 Run 去重", () => {
    const done = doneNotification({ runId: "run_1", runTitle: "写文档", status: "done", elapsedMs: 1200 });
    assert.match(done.title, /完成/);
    assert.match(done.body, /1\.2s/);
    assert.strictEqual(done.tag, "run:run_1:done");

    const failed = doneNotification({ runId: "run_2", runTitle: "写文档", status: "failed", elapsedMs: 0 });
    assert.match(failed.title, /失败/);
  });

  it("多工作区时文案带工作区名，不说清是谁等于没说", () => {
    const approval = approvalNotification({
      approvalId: "ap_2",
      runTitle: "写文档",
      toolName: "write_file",
      workspaceName: "mini-pi",
    });
    assert.match(approval.body, /【mini-pi】/);

    const done = doneNotification({
      runId: "run_3",
      runTitle: "写文档",
      status: "done",
      elapsedMs: 500,
      workspaceName: "blog",
    });
    assert.match(done.body, /【blog】/);

    // 不带名字（单工作区 / 旧帧）时维持原样，没有空括号
    const plain = doneNotification({
      runId: "run_4",
      runTitle: "写文档",
      status: "done",
      elapsedMs: 500,
    });
    assert.doesNotMatch(plain.body, /【/);
  });

  it("铃铛 tooltip 说清开不了的原因", () => {
    assert.match(
      notificationButtonTitle({ supported: false, permission: "default", enabled: false }),
      /不支持/,
    );
    assert.match(
      notificationButtonTitle({ supported: true, permission: "denied", enabled: false }),
      /已拒绝/,
    );
    assert.match(
      notificationButtonTitle({ supported: true, permission: "granted", enabled: false }),
      /开启/,
    );
    assert.match(
      notificationButtonTitle({ supported: true, permission: "granted", enabled: true }),
      /关闭/,
    );
  });
});

describe("环境探测与真弹出", () => {
  it("没有 Notification 时如实说「不支持」，不假装能开", () => {
    const state = detectNotifications();
    assert.strictEqual(state.supported, false);
    assert.strictEqual(state.enabled, false);
  });

  it("有 Notification 时读权限；没记住偏好就不算开着", () => {
    (globalThis as { Notification?: unknown }).Notification = FakeNotification;
    const state = detectNotifications();
    assert.strictEqual(state.supported, true);
    assert.strictEqual(state.permission, "granted");
    assert.strictEqual(state.enabled, false, "偏好没开过就不该自动开");
  });

  it("弹出时带上 body/tag，并接住点击回调", () => {
    (globalThis as { Notification?: unknown }).Notification = FakeNotification;
    let clicked = 0;
    const shown = showSystemNotification(
      { title: "需要你的裁决 · mini-pi", body: "写文档 请求执行 write_file", tag: "ap:1" },
      () => {
        clicked += 1;
      },
    );

    assert.strictEqual(shown, true);
    assert.strictEqual(FakeNotification.created.length, 1);
    assert.strictEqual(FakeNotification.created[0]!.options?.tag, "ap:1");
    FakeNotification.created[0]!.onclick?.();
    assert.strictEqual(clicked, 1);
  });

  it("构造抛错时只返回 false，不影响界面", () => {
    (globalThis as { Notification?: unknown }).Notification = class {
      constructor() {
        throw new Error("权限没了");
      }
    };
    assert.strictEqual(
      showSystemNotification({ title: "t", body: "b", tag: "x" }),
      false,
    );
  });
});
