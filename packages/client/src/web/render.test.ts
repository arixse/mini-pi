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
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";
import { ClientProvider, ClientStore } from "./store";
import { initialState, type TimelineItem } from "./state";
import { Composer } from "./components/Composer";
import { TimelineItemRow } from "./components/TimelineItems";
import { RunHead } from "./components/RunHead";
import { DiffPanel } from "./components/DiffPanel";
import { Sidebar } from "./components/Sidebar";
import { Statusbar } from "./components/Statusbar";
import type { ComposerHandle } from "./controller";
import type { Actions } from "./actions";
import type { ApprovalRequest, RunDiff, RunSummary } from "../shared/types";

/** 渲染用的假动作：这里只验证 markup，不触发任何请求 */
const fakeActions = {
  send: () => undefined,
  stop: () => undefined,
  recall: async () => undefined,
  cancelRun: async () => undefined,
  discardWorktree: async () => true,
  openDiff: () => undefined,
  closeDiff: () => undefined,
  openFile: () => undefined,
  closeFile: () => undefined,
  mergeWorktree: async () => undefined,
  newTask: () => undefined,
  newTaskIn: async () => undefined,
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
  openWorkspace: async () => undefined,
  focusWorkspace: async () => undefined,
  closeWorkspace: async () => undefined,
  requestDelete: () => undefined,
  cancelDelete: () => undefined,
  confirmDelete: async () => undefined,
  retry: () => undefined,
  retryStreams: () => undefined,
} as unknown as Actions;

function renderComposer(store: ClientStore): string {
  return renderToStaticMarkup(
    createElement(
      ClientProvider,
      { value: { store, actions: fakeActions } },
      createElement(Composer, { handleRef: createRef<ComposerHandle | null>() }),
    ),
  );
}

/** 把发送/停止那一颗按钮从整页 markup 里切出来，避免命中别的 disabled 控件 */
function sendButton(html: string): string {
  const match = html.match(/<button class="btn-send[^"]*"[\s\S]*?<\/button>/);
  assert.ok(match, "输入区必须有一颗发送/停止按钮");
  return match[0];
}

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
  it("首屏渲染不抛错：主列三层骨架都在", () => {
    const html = renderToStaticMarkup(createElement(App));

    assert.match(html, /class="app"/, "根容器要挂上");
    assert.match(html, /class="topbar"/);
    assert.match(html, /class="main-col"/, "主列三层：状态行 / 会话 / 输入区");
    assert.match(html, /class="sidebar"/);
    assert.match(html, /class="composer"/);
    // 还没有工作区：状态行整个不渲染（空态稿第 5 页主列只有引导）
    assert.doesNotMatch(html, /class="statusbar"/);
    assert.match(html, /还没有工作区/, "还没拿到状态时应如实说工作区未打开");
    assert.match(html, /未配置模型/, "还没拿到状态时不该假装模型已配好");
  });

  it("状态行属于主列且只有三枚指标：模型 / 上下文 / 步数", () => {
    const store = new ClientStore();
    store.update((state) => {
      state.workspace = { root: "/tmp/ws", name: "ws" };
    });
    const html = renderToStaticMarkup(
      createElement(
        ClientProvider,
        { value: { store, actions: fakeActions } },
        createElement(Statusbar),
      ),
    );
    assert.match(html, /class="statusbar"/);
    assert.match(html, />模型</);
    assert.match(html, />上下文</);
    assert.match(html, />步数</);
    assert.doesNotMatch(html, />状态</, "设计稿只有三枚指标，不画第四个");
  });

  it("只读历史会话里挂着 live Run 时，唯一的停止键仍然在", () => {
    const store = new ClientStore();
    store.update((state) => {
      state.workspace = { root: "/tmp/ws", name: "ws" };
      state.activeRoot = "/tmp/ws";
      state.sendable = true;
      state.view.sessionId = "s1.jsonl";
      state.view.root = "/tmp/ws";
      state.view.readOnly = true;
      state.view.status = "running";
      state.view.activeRunId = "run_1";
    });
    const html = renderComposer(store);
    const button = sendButton(html);
    assert.match(button, /停止/, "只读不等于不能停");
    assert.doesNotMatch(button, /新任务/, "有 live Run 时按钮不能变成开新任务");
    assert.doesNotMatch(button, /disabled/, "停止键不能被禁用");
  });

  it("只读且没有 live Run 时，「新任务」空输入也可点", () => {
    const store = new ClientStore();
    store.update((state) => {
      state.workspace = { root: "/tmp/ws", name: "ws" };
      state.activeRoot = "/tmp/ws";
      state.sendable = true;
      state.view.sessionId = "s1.jsonl";
      state.view.root = "/tmp/ws";
      state.view.readOnly = true;
      state.view.status = "idle";
    });
    const html = renderComposer(store);
    const button = sendButton(html);
    assert.match(button, /新任务/);
    assert.doesNotMatch(button, /disabled/, "提示语让点「新任务」，就不能把它灰掉");
  });

  it("没有工作区时主区是品牌引导：一句话 + 选择目录", () => {
    const html = renderToStaticMarkup(createElement(App));

    assert.match(html, /class="empty-guide"/, "主区放品牌引导，不是一片空白");
    assert.match(html, /选择目录/);
    assert.match(html, /mini-pi/);
    // 侧栏只留一句提示，不摆一棵空树
    assert.match(html, /还没有工作区/);
  });

  it("开新会话的入口挂在工作区节点上：一个工作区一个，空池没有", () => {
    const empty = new ClientStore();
    const htmlEmpty = renderToStaticMarkup(
      createElement(
        ClientProvider,
        { value: { store: empty, actions: fakeActions } },
        createElement(Sidebar),
      ),
    );
    assert.doesNotMatch(htmlEmpty, /开一段新会话/, "没有工作区就没有落点，别摆空入口");

    const ready = new ClientStore();
    ready.update((state) => {
      state.activeRoot = "/tmp/a";
      state.workspaces = [
        {
          root: "/tmp/a",
          name: "a",
          sessions: [],
          runs: [],
          currentSessionId: null,
          approvals: { pending: 0 },
          sendable: true,
          blockReason: null,
          isolate: false,
          isolateError: null,
        },
        {
          root: "/tmp/b",
          name: "b",
          sessions: [],
          runs: [],
          currentSessionId: null,
          approvals: { pending: 0 },
          sendable: true,
          blockReason: null,
          isolate: false,
          isolateError: null,
        },
      ];
    });
    const htmlReady = renderToStaticMarkup(
      createElement(
        ClientProvider,
        { value: { store: ready, actions: fakeActions } },
        createElement(Sidebar),
      ),
    );
    assert.match(htmlReady, /aria-label="在「a」开一段新会话"/);
    assert.match(htmlReady, /aria-label="在「b」开一段新会话"/, "每个工作区各自一个入口");
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
  function diffStore(truncated = false): ClientStore {
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
      files: ["src/a.ts", "src/b.ts"],
      truncated: false,
      patch: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,3 @@",
        " keep",
        "-old",
        "+new",
        "+newer",
        "diff --git a/src/b.ts b/src/b.ts",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -1 +1,2 @@",
        "keep",
        "+added",
      ].join("\n"),
    };
    store.update((state) => {
      state.runs = [run];
      state.ui.diffRunId = "run_1";
      state.diff = { ...diff, truncated };
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
    assert.match(html, /class="diff-file-block"/, "按文件分组，一次改十几个文件才折叠得起来");
    assert.match(html, /class="diff-hunk-head"/, "hunk 头单独一层，可整段折叠");
    assert.match(html, /@@ -1,2 \+1,3 @@/, "hunk 头原样显示（行号范围是定位信息）");
    assert.doesNotMatch(html, /diff-row diff-meta/, "文件头不再混进行列表");
    assert.match(html, /\+3/, "面板头给出整体增行数");
    assert.match(html, /−1/, "面板头给出整体删行数");
    assert.match(html, /\+2/, "文件条给出每个文件自己的增行数");
    assert.match(html, /src\/b\.ts[\s\S]*?\+1/, "第二个文件条也带统计");
    assert.match(html, /应用变更/);
    assert.match(html, /放弃变更/);
    assert.match(html, /返回/);
  });

  /**
   * 截断的话必须单独挂在顶部：正文尾巴里那句提示会被折叠或滚动藏起来，
   * 而"这份改动不完整"直接决定用户敢不敢点应用。
   */
  it("被截断时有独立横幅（不是藏在正文末尾）", () => {
    const html = renderToStaticMarkup(
      createElement(
        ClientProvider,
        { value: { store: diffStore(true), actions: fakeActions } },
        createElement(DiffPanel),
      ),
    );
    assert.match(html, /变更过大/, "顶部要有截断横幅");
    assert.match(html, /应用时按完整改动落地/, "截断只是显示不全，应用仍是完整的那份");
  });

  it("没截断时没有这条横幅（别让提示一直挂着）", () => {
    const html = renderToStaticMarkup(
      createElement(
        ClientProvider,
        { value: { store: diffStore(false), actions: fakeActions } },
        createElement(DiffPanel),
      ),
    );
    assert.doesNotMatch(html, /变更过大/);
  });

  it("面板画在主列里：内嵌面板而非遮罩模态", () => {
    const html = renderToStaticMarkup(
      createElement(
        ClientProvider,
        { value: { store: diffStore(), actions: fakeActions } },
        createElement(DiffPanel),
      ),
    );
    assert.match(html, /class="diff-panel"/, "主列内嵌容器");
    assert.match(html, /class="diff-card"/, "带描边的卡片");
    assert.doesNotMatch(html, /class="overlay"/, "不铺全屏遮罩——侧栏与输入区都在场");
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
      at: 0,
      runId: "run_q",
    });
    assert.match(html, /bubble-user queued/, "空心描边气泡（与已执行的实心区分）");
    assert.match(html, /已入队 · 当前回合结束后执行/);
    assert.match(html, /撤回/);
    assert.doesNotMatch(html, /bubble-time/, "入队中的那条不画时刻");
  });

  it("已执行的消息气泡内带发出时刻（14:02）", () => {
    // 本地时区 2026-10-22 14:02（构造时固定时分，跨时区跑也只断言格式）
    const html = renderItem({
      kind: "user",
      id: "u:1#2",
      text: "跑一遍测试",
      queued: false,
      locked: true,
      at: new Date(2026, 9, 22, 14, 2).getTime(),
      runId: null,
    });
    assert.match(html, /bubble-time[^<]*>14:02</);
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

  it("输出被裁过才给「查看完整输出 / 复制」：短输出不摆链接", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const collapsed = renderItem({
      kind: "tool",
      id: "t:2",
      toolCallId: "2",
      name: "bash",
      args: "ls",
      status: "done",
      output: long,
      startedAt: 0,
      durationMs: 10,
    });
    assert.match(collapsed, /查看完整输出/, "长输出给看全的入口");
    assert.match(collapsed, /复制/, "并给复制");
    const short = renderItem({
      kind: "tool",
      id: "t:3",
      toolCallId: "3",
      name: "bash",
      args: "ls",
      status: "done",
      output: "a.ts",
      startedAt: 0,
      durationMs: 10,
    });
    assert.doesNotMatch(short, /tool-links/, "短输出全在眼前，链接只是噪音");
  });

  it("审批卡三个动作：允许一次 / 本会话全部允许 / 拒绝（变更入口不在卡上）", () => {
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
    assert.doesNotMatch(html, /看变更/, "审批挂起时读 diff 必然 409：入口挪到主列");
    assert.match(html, /data-pending-approval="true"/, "挂起的卡片要能被徽标跳转选中");

    const resolved = renderItem({
      kind: "approval",
      id: "ap:ap1",
      request: approval(),
      state: "approved",
    });
    assert.doesNotMatch(resolved, /data-pending-approval/, "已裁决的卡片不再算跳转目标");
  });

  it("隔离改动条：列出未合并 Run；运行中禁用「看变更」，合并/丢弃后不再出现", () => {
    const store = new ClientStore();
    const base = {
      sessionId: "s1.jsonl",
      model: "m",
      elapsedMs: null,
      tokens: 0,
      contextWindow: 128000,
      pendingApprovals: 0,
      root: "/tmp/ws",
    };
    store.update((state) => {
      state.workspace = { root: "/tmp/ws", name: "ws" };
      state.activeRoot = "/tmp/ws";
      state.view.root = "/tmp/ws";
      state.runs = [
        {
          ...base,
          runId: "run_live",
          title: "还在跑的任务",
          status: "running",
          startedAt: 30,
          workspace: { root: "/tmp/wt/live", isolated: true, released: false, merged: false },
        },
        {
          ...base,
          runId: "run_done",
          title: "等待审阅的任务",
          status: "done",
          startedAt: 20,
          workspace: { root: "/tmp/wt/done", isolated: true, released: false, merged: false },
        },
        {
          ...base,
          runId: "run_merged",
          title: "已经合并的任务",
          status: "done",
          startedAt: 10,
          workspace: { root: "/tmp/wt/merged", isolated: true, released: false, merged: true },
        },
        {
          ...base,
          runId: "run_released",
          title: "已经丢弃的任务",
          status: "done",
          startedAt: 5,
          workspace: { root: "/tmp/wt/released", isolated: true, released: true, merged: false },
        },
      ];
    });
    const html = renderToStaticMarkup(
      createElement(
        ClientProvider,
        { value: { store, actions: fakeActions } },
        createElement(RunHead),
      ),
    );
    assert.match(html, /待审阅的隔离改动/);
    assert.match(html, /还在跑的任务/);
    assert.match(html, /等待审阅的任务/);
    assert.match(html, /运行中/);
    assert.match(html, /待审阅/);
    assert.strictEqual((html.match(/看变更/g) ?? []).length, 2);
    assert.match(html, /disabled=""/, "运行中的任务不能读 diff");
    assert.doesNotMatch(html, /已经合并的任务/);
    assert.doesNotMatch(html, /已经丢弃的任务/);
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
