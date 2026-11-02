/**
 * 工具输出里的路径"能不能点"。
 *
 * 规则只有一条：**确认存在才画下划线**。
 *
 * 之前是"看着像路径就画一条链接，点开再说"。可工具输出里提到的路径并不都存在——
 * 模型会先写"我来创建 src/new.ts"、报错栈里带着已经删掉的文件、历史会话里的
 * 路径也会过时。点开这样一条链接，右侧面板只回一句「文件不存在」，用户还得
 * 手动把它关掉：一个"可点"的承诺被打破一次，比一开始就没有链接更糟。
 *
 * 于是判定反过来：先问一句"还在不在"（`actions.checkPaths`），答"在"才画，
 * 答"不在"就是普通文本（一个字都不少，只是没有下划线）。**问到答案之前也按
 * 普通文本处理**：少一条迟到的下划线，好过一条假的链接。
 */

import type { ClientState } from "./state";

/** 一次判定的范围：根 + 可选 Run（隔离执行干活的目录是另一个） */
export type PathScope = { root: string; runId: string | null };

/**
 * 缓存键：根与 Run 都参与。
 *
 * 同名的 `src/a.ts` 在不同工作区、以及隔离 worktree 里是**三份不同的东西**；
 * 只用路径当键，A 工作区的"存在"会替 B 工作区的"不存在"背书。
 * `\u0000` 分隔：路径里不可能出现 NUL，拼出来的键因此不会撞。
 */
export function pathScopeKey(scope: PathScope, path: string): string {
  return `${scope.root}\u0000${scope.runId ?? ""}\u0000${path}`;
}

/**
 * 当前该按哪个范围判定。
 *
 * 根取 `view.root`（正看着的那段会话属于谁），草稿态还没有 view 时退回
 * `activeRoot`——与 `openFile` 读文件时的寻址保持一致，否则会出现
 * "问的是一个工作区、点开的是另一个"。
 */
export function pathScopeOf(state: ClientState, runId?: string | null): PathScope {
  return { root: state.view.root ?? state.activeRoot, runId: runId ?? null };
}

/** 这条路径确认存在吗；`null` = 还没问过（按普通文本显示） */
export function pathExists(
  state: ClientState,
  scope: PathScope,
  path: string,
): boolean | null {
  const value = state.pathExists[pathScopeKey(scope, path)];
  return value === undefined ? null : value;
}
