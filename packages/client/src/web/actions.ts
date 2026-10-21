/**
 * 界面动作的契约。
 *
 * 渲染层只声明"能点出什么"，不关心怎么发请求；`app.ts` 是唯一的实现方。
 * 这样渲染函数可以被当成纯函数测（给定状态 + 假 actions，断言 DOM 结构）。
 */

import type { ApprovalAnswer, Tier } from "../shared/types";

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
  /** 丢弃某个 Run 的隔离工作区（M3）：跑着的任务服务端会拒绝 */
  discardWorktree: (runId: string) => Promise<void>;
  /** 打开某个隔离 Run 的变更面板（读 diff） */
  openDiff: (runId: string) => void;
  closeDiff: () => void;
  /** 把隔离改动合并回基准工作区；冲突时服务端 409，worktree 保留 */
  mergeWorktree: (runId: string) => Promise<void>;
  newTask: () => void;
  openSession: (sessionId: string) => void;
  openRun: (runId: string) => void;
  decide: (approvalId: string, answer: ApprovalAnswer) => void;
  setSearch: (keyword: string) => void;
  toggleSidebar: () => void;
  closeSidebar: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  saveModel: (input: SaveModelInput) => Promise<void>;
  setTier: (tier: Tier) => Promise<void>;
  setSubAgent: (enabled: boolean) => Promise<void>;
  /** 隔离开关：只影响之后新发的任务；环境不支持时服务端 409 */
  setIsolate: (enabled: boolean) => Promise<void>;
  /** 通知开关：第一次点会申请权限（必须在用户手势里），之后是开/关 */
  toggleNotifications: () => Promise<void>;
  openPicker: () => void;
  closePicker: () => void;
  switchWorkspace: (path: string) => Promise<void>;
  requestDelete: (sessionId: string) => void;
  cancelDelete: () => void;
  confirmDelete: () => Promise<void>;
  retry: () => void;
};
