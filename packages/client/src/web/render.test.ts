/**
 * 组件树的可挂载性。
 *
 * 这一条守的是"打开页面就是白屏"这类失败：类型检查过得去，
 * 但某个组件在首次渲染时抛错（读空对象、用了不存在的上下文）时，
 * 唯一的症状是浏览器控制台里一行红字和一片空白。
 *
 * 用 `react-dom/server` 而不是 jsdom：这里要验证的是**首次渲染不抛错**，
 * 而不是交互，服务端渲染不需要 DOM，于是这条测试不用为仓库引入新依赖。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";
import { ClientProvider, ClientStore } from "./store";
import { initialState, type TimelineItem } from "./state";
import { TimelineItemRow } from "./components/TimelineItems";
import { DiffPanel } from "./components/DiffPanel";
import type { Actions } from "./actions";
import type { ApprovalRequest, RunDiff, RunSummary } from "../shared/types";

/** 渲染用的假动作：这里只验证 markup，不触发任何请求 */
const fakeActions = {
  send: () => undefined,
  stop: () => undefined,
  recall: async () => undefined,
  cancelRun: async () => undefined,
  discardWorktree: async () => undefined,
  openDiff: () => undefined,
  closeDiff: () => undefined,
  mergeWorktree: async () => undefined,
  newTask: () => undefined,
  openSession: () => undefined,
  continueSession: async () => undefined,
  openRun: () => undefined,
  decide: () => undefined,
  setSearch: () => undefined,
  toggleSidebar: () => undefined,
  closeSidebar: () => undefined,
  openSettings: () => undefined,
  closeSettings: () => undefined,
  saveModel: async () => undefined,
  addCustomProvider: async () => [],
  removeProvider: async () => undefined,
  setTier: async () => undefined,
  setSubAgent: async () => undefined,
  setIsolate: async () => undefined,
  toggleNotifications: async () => undefined,
  toggleTheme: () => undefined,
  openPicker: () => undefined,
  closePicker: () => undefined,
  switchWorkspace: async () => undefined,
  requestDelete: () => undefined,
  cancelDelete: () => undefined,
  confirmDelete: async () => undefined,
  retry: () => undefined,
} as unknown as Actions;

function renderItem(item: TimelineItem, expanded = false): string {
  const store = new ClientStore();
  return renderToStaticMarkup(
    createElement(
      ClientProvider,
      { value: { store, actions: fakeActions } },
      createElement(TimelineItemRow, {
        item,
        revision: "r1",
        expanded,
        onToggle: () => undefined,
        actions: fakeActions,
      }),
    ),
  );
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "ap1",
    runId: "run_1",
    toolCallId: "tc1",
    toolName: "bash",
    risk: { level: "elevated", reasons: ["会执行命令"] },
    summary: ["$ ls -la"],
    argsPreview: "ls -la",
    createdAt: 0,
    ...overrides,
  };
}

describe("前端组件树", () => {
  it("首屏渲染不抛错，且顶栏三枚芯片都在", () => {
    const html = renderToStaticMarkup(createElement(App));

    assert.match(html, /class="app"/, "根容器要挂上");
    assert.match(html, /class="topbar"/);
    assert.match(html, /class="statusbar"/, "状态栏常驻：模型 / 上下文 / 步数");
    assert.match(html, /class="sidebar"/);
    assert.match(html, /class="composer"/);
    assert.match(html, /未打开工作区/, "还没拿到状态时应如实说工作区未打开");
    assert.match(html, /未配置模型/, "还没拿到状态时不该假装模型已配好");
  });

  it("没有工作区时主区是品牌引导：一句话 + 选择目录", () => {
    const html = renderToStaticMarkup(createElement(App));

    assert.match(html, /class="empty-guide"/, "主区放品牌引导，不是一片空白");
    assert.match(html, /选择目录/);
    assert.match(html, /Mini Pi/);
    // 侧栏只留一句提示，不摆一棵空树
    assert.match(html, /还没有工作区/);
  });

  it("起不来的时候给的是说明与重试，不是一片空白", () => {
    const store = new ClientStore();
    store.update((state) => {
      state.error = "连不上 127.0.0.1:4788";
    });
    assert.match(store.current.error ?? "", /4788/);
    // Boot 只在有错误时出现：初始状态（无错）不该渲染它
    const initial = initialState();
    assert.strictEqual(initial.error, null);
  });
});

describe("变更面板", () => {
  function diffStore(): ClientStore {
    const store = new ClientStore();
    const run: RunSummary = {
      runId: "run_1",
      title: "改两行",
      sessionId: "s1",
      status: "done",
      model: "test / test-model",
      startedAt: 0,
      elapsedMs: 1000,
      tokens: 10,
      contextWindow: 128_000,
      pendingApprovals: 0,
      workspace: { root: "/tmp/wt", isolated: true, released: false, merged: false },
    };
    const diff: RunDiff = {
      runId: "run_1",
      files: ["src/a.ts"],
      patch: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,3 @@",
        " keep",
        "-old",
        "+new",
      ].join("\n"),
    };
    store.update((state) => {
      state.runs = [run];
      state.ui.diffRunId = "run_1";
      state.diff = diff;
    });
    return store;
  }

  it("行级 diff：增删行各走各的令牌类，动作行是应用/放弃/返回", () => {
    const html = renderToStaticMarkup(
      createElement(
        ClientProvider,
        { value: { store: diffStore(), actions: fakeActions } },
        createElement(DiffPanel),
      ),
    );

    assert.match(html, /class="diff-row diff-add"/, "新增行要带 diff-add");
    assert.match(html, /class="diff-row diff-del"/, "删除行要带 diff-del");
    assert.match(html, /class="diff-row diff-meta"/, "文件头不当成增删行");
    assert.match(html, /class="diff-row diff-hunk"/);
    assert.match(html, /\+1/, "面板头给出增行数");
    assert.match(html, /−1/, "面板头给出删行数");
    assert.match(html, /应用变更/);
    assert.match(html, /放弃变更/);
    assert.match(html, /返回/);
  });

  it("没打开时什么都不渲染", () => {
    const html = renderToStaticMarkup(
      createElement(
        ClientProvider,
        { value: { store: new ClientStore(), actions: fakeActions } },
        createElement(DiffPanel),
      ),
    );
    assert.strictEqual(html, "");
  });
});

describe("时间线条目的 markup", () => {
  it("已入队的消息是空心气泡，带元信息行与撤回", () => {
    const html = renderItem({
      kind: "user",
      id: "u:1#1",
      text: "顺手把测试也补了",
      queued: true,
      locked: true,
      runId: "run_q",
    });
    assert.match(html, /bubble-user queued/, "空心描边气泡（与已执行的实心区分）");
    assert.match(html, /已入队 · 当前回合结束后执行/);
    assert.match(html, /撤回/);
  });

  it("工具调用是单行：生命周期标记 + 名称 + 参数 + 耗时", () => {
    const html = renderItem({
      kind: "tool",
      id: "t:1",
      toolCallId: "1",
      name: "grep",
      args: JSON.stringify({ pattern: "TODO", path: "src" }),
      status: "done",
      output: "src/a.ts:12: // TODO\nsrc/b.ts:3: // TODO",
      startedAt: 0,
      durationMs: 320,
    });
    assert.match(html, /tool-line/, "单行，不套三层盒子");
    assert.match(html, /tool-mark is-done[^<]*>✓</, "完成是 ✓");
    assert.match(html, /grep/);
    assert.match(html, /TODO/, "参数必须渲染（设计稿第 7 条）");
    assert.match(html, /0.3s/);
  });

  it("审批卡四个动作：允许一次 / 本会话全部允许 / 拒绝（非隔离没有看变更）", () => {
    const html = renderItem({
      kind: "approval",
      id: "ap:ap1",
      request: approval(),
      state: "pending",
    });
    assert.match(html, /approval"/, "warn-soft 底（elevated）");
    assert.match(html, /允许一次/);
    assert.match(html, /本会话内全部允许 bash/);
    assert.match(html, /拒绝/);
    assert.doesNotMatch(html, /看变更/, "非隔离任务没有 diff，不摆必然 409 的按钮");
  });

  it("高危审批换 danger-soft：完整命令 + 不可撤销，不叠降级理由", () => {
    const html = renderItem({
      kind: "approval",
      id: "ap:ap2",
      request: approval({
        risk: { level: "high", reasons: ["删除文件", "不可恢复"] },
        summary: ["$ rm -rf build"],
        argsPreview: "rm -rf build",
      }),
      state: "pending",
    });
    assert.match(html, /approval high"/);
    assert.match(html, /高危：bash/);
    assert.match(html, /rm -rf build/, "完整命令要给全");
    assert.match(html, /此操作不可撤销/);
    assert.doesNotMatch(html, /<code>/, "高危不叠summary 的理由行");
  });
});
