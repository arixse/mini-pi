/**
 * 界面动作的契约。
 *
 * 渲染层只声明"能点出什么"，不关心怎么发请求；`app.ts` 是唯一的实现方。
 * 这样渲染函数可以被当成纯函数测（给定状态 + 假 actions，断言 DOM 结构）。
 */

import type { ApprovalAnswer, ProviderView, Tier } from "../shared/types";

export type SaveModelInput = {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindow?: number | null;
  tier?: Tier;
};

export type Actions = {
  send: (text: string) => void;
  stop: () => void;
  /**
   * 撤回一条"已入队"的消息（时间线里那条空心气泡上的「撤回」）。
   *
   * 内核对排队中的 Run 直接出队并给 cancelled 结论；已经开跑的消息
   * 撤不回——取消只停得下还没执行的部分，说出去的话留在历史里。
   * 返回 Promise：调用方（测试）要能等到取消请求真的发出去。
   */
  recall: (id: string) => Promise<void>;
  /**
   * 取消指定的一条 Run（侧栏行菜单 / 撤回排队消息都走这里）。
   *
   * 与 {@link Actions.stop} 的分工：`stop` 作用于"正在看的那个 Run"，
   * 这个能点名侧栏里任意一条——包括还没开始执行的排队项
   * （内核对排队中的 Run 直接出队并给 cancelled 结论）。
   */
  cancelRun: (runId: string) => Promise<void>;
  /** 丢弃某个 Run 的隔离工作区（M3）：跑着的任务服务端会拒绝 */
  discardWorktree: (runId: string) => Promise<void>;
  /** 打开某个隔离 Run 的变更面板（读 diff） */
  openDiff: (runId: string) => void;
  closeDiff: () => void;
  /** 把隔离改动合并回基准工作区；冲突时服务端 409，worktree 保留 */
  mergeWorktree: (runId: string) => Promise<void>;
  newTask: () => void;
  openSession: (sessionId: string) => void;
  /**
   * 打开一段会话并把焦点放进输入框（侧栏行的 `+`）。
   *
   * 与 {@link Actions.openSession} 只差"聚焦"：对当前会话来说这就是
   * "接着写"，对历史会话则打开只读回看——由 composer 自己说明状态。
   */
  continueSession: (sessionId: string) => Promise<void>;
  openRun: (runId: string) => void;
  decide: (approvalId: string, answer: ApprovalAnswer) => void;
  setSearch: (keyword: string) => void;
  toggleSidebar: () => void;
  closeSidebar: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  saveModel: (input: SaveModelInput) => Promise<void>;
  /**
   * 只存供应商凭据、不设默认模型（自定义供应商区的「添加」）。
   *
   * 返回刷新后的供应商列表：调用方要立刻把新条目摆到界面上，
   * 再让用户进去选模型——顺序不能颠倒。
   */
  addCustomProvider: (input: {
    provider: string;
    apiKey?: string;
    baseUrl?: string;
  }) => Promise<ProviderView[]>;
  /** 删掉一个自定义供应商；默认模型指着它时服务端会一并清掉 */
  removeProvider: (name: string) => Promise<void>;
  setTier: (tier: Tier) => Promise<void>;
  setSubAgent: (enabled: boolean) => Promise<void>;
  /** 隔离开关：只影响之后新发的任务；环境不支持时服务端 409 */
  setIsolate: (enabled: boolean) => Promise<void>;
  /** 通知开关：第一次点会申请权限（必须在用户手势里），之后是开/关 */
  toggleNotifications: () => Promise<void>;
  /** 主题：只切根节点 data-theme 并记住选择（见 theme.ts） */
  toggleTheme: () => void;
  openPicker: () => void;
  closePicker: () => void;
  switchWorkspace: (path: string) => Promise<void>;
  requestDelete: (sessionId: string) => void;
  cancelDelete: () => void;
  confirmDelete: () => Promise<void>;
  retry: () => void;
};
