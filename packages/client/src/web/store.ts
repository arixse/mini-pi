/**
 * 前端状态容器：React 与"就地修改的归约逻辑"之间那层薄胶水。
 *
 * 为什么不是 `useReducer`：流式输出每秒几十条 `message_update`，
 * 每来一条克隆整棵时间线纯属浪费（`state.ts` 的取舍写在那儿）。
 * 于是这里保留**可变状态**，只额外提供一个自增的 `revision` 给
 * `useSyncExternalStore` 当快照——组件读的是同一份对象，React 靠
 * revision 变化知道"该重画了"。
 *
 * 通知按帧合并：一帧里的多次 `update` 只重画一次，等价于原实现的
 * `schedule()`。事件流回调、定时器、fetch 回来都走同一条路，
 * 因此"每秒重画几次"与事件到达频率无关。
 */

import { createContext, useContext, useSyncExternalStore } from "react";
import { initialState, type ClientState } from "./state";
import type { Actions } from "./actions";

export class ClientStore {
  private state: ClientState = initialState();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private scheduled = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** `useSyncExternalStore` 的快照：数值，天然可比较 */
  readonly getRevision = (): number => this.revision;

  /** 组件在渲染时直接读它：永远是最新的一份 */
  get current(): ClientState {
    return this.state;
  }

  /** 就地修改，并在本帧末尾统一通知一次 */
  update(mutator: (state: ClientState) => void): void {
    mutator(this.state);
    this.schedule();
  }

  /** 内容没变、只是该重画了（运行中的耗时在走字） */
  touch(): void {
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.revision += 1;
      for (const listener of [...this.listeners]) {
        listener();
      }
    });
  }
}

export type ClientContextValue = { store: ClientStore; actions: Actions };

const ClientContext = createContext<ClientContextValue | null>(null);

export const ClientProvider = ClientContext.Provider;

/**
 * 订阅版本号。
 *
 * 状态对象是可变的（引用不变），所以"变了没有"只能看这个计数器。
 * 效应（自动滚动、定时器）要拿它当依赖——拿 state 是没有用的。
 */
export function useRevision(): number {
  const value = useContext(ClientContext);
  if (!value) {
    throw new Error("useRevision 必须在 ClientProvider 内使用");
  }
  return useSyncExternalStore(value.store.subscribe, value.store.getRevision, value.store.getRevision);
}

/** 读状态：容器变化即重画 */
export function useClient(): ClientState {
  const value = useContext(ClientContext);
  if (!value) {
    throw new Error("useClient 必须在 ClientProvider 内使用");
  }
  useRevision();
  return value.store.current;
}

/** 读动作：引用恒定，可以安全进依赖数组 */
export function useActions(): Actions {
  const value = useContext(ClientContext);
  if (!value) {
    throw new Error("useActions 必须在 ClientProvider 内使用");
  }
  return value.actions;
}
