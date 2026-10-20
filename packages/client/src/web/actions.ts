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
  openPicker: () => void;
  closePicker: () => void;
  switchWorkspace: (path: string) => Promise<void>;
  requestDelete: (sessionId: string) => void;
  cancelDelete: () => void;
  confirmDelete: () => Promise<void>;
  retry: () => void;
};
