/**
 * 桌面壳的"用哪个工作区"。
 *
 * 一句话：**没有默认工作区**。优先级是三段——
 *
 * 1. `--cwd` 显式指定：一次性指定，直接用它，也不改写记忆；
 * 2. 上次选择的目录还在：直接开它，不问；
 * 3. 都没有：弹出系统目录框问一次，选完记下来。
 *
 * 为什么不能像 `serve` 那样默认用 `process.cwd()`：从快捷方式 / Dock /
 * 双击图标启动时，当前目录是哪儿都不一定（macOS 上甚至是 `/`），
 * 而 agent 会真的读写那个目录——"默认工作区"在这里不是便利，是误伤。
 *
 * 用户**取消**选择框时返回 `cancelled` 而不是退回默认值：退回就等于
 * 刚才那个"误伤"又回来了，只是用户没看见。
 */

import { WorkspaceHost } from "../server/host";
import { readRememberedWorkspace, rememberWorkspace } from "../server/workspaceMemory";
import type { ServeArgs } from "../server/serveArgs";

/** 弹出目录框的方式；浏览器形态没有，因此是可选的 */
export type WorkspacePick = () => Promise<string | null>;

export type WorkspaceResolution =
  | { kind: "ok"; root: string }
  /** 用户关了选择框：调用方应当收掉窗口退出，而不是挑一个目录替他决定 */
  | { kind: "cancelled" }
  /** 没有可用工作区，也没有问的手段（浏览器形态且没有记忆） */
  | { kind: "missing"; message: string };

export type ResolveWorkspaceOptions = {
  /** 弹目录框；缺省没有（浏览器形态） */
  pick?: WorkspacePick;
  /** 记忆文件路径；缺省 `~/.mini-pi/client-workspace.json`（测试传临时目录） */
  memoryFile?: string;
};

/** 目录不存在（或根本不是目录）时不算可用：记忆里的路径可能早就删了 */
function isUsableWorkspace(path: string): boolean {
  try {
    WorkspaceHost.assertWorkspaceRoot(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 决定这次启动用哪个工作区。
 *
 * `args` 只需要 `cwd` / `cwdGiven` 两个字段——`desktop` 与 Electron 主进程
 * 共用它，两者拿到的参数本来就是同一份（`parseServeArgs`）。
 */
export async function resolveDesktopWorkspace(
  args: Pick<ServeArgs, "cwd" | "cwdGiven">,
  options: ResolveWorkspaceOptions = {},
): Promise<WorkspaceResolution> {
  // 显式指定优先，且**不记忆**：`desktop --cwd /tmp/x` 是一次性指定，
  // 不该把"下次开哪儿"改掉
  if (args.cwdGiven) {
    return { kind: "ok", root: args.cwd };
  }

  const remembered = await readRememberedWorkspace(options.memoryFile);
  if (remembered && isUsableWorkspace(remembered)) {
    return { kind: "ok", root: remembered };
  }

  const pick = options.pick;
  if (!pick) {
    return {
      kind: "missing",
      message:
        "桌面壳没有默认工作区：请用 --cwd 指定一个目录，" +
        "或用 Electron 形态启动（首次启动时会询问，之后记住上次的选择）",
    };
  }

  const picked = await pick();
  if (!picked) {
    return { kind: "cancelled" };
  }
  if (!isUsableWorkspace(picked)) {
    return { kind: "missing", message: `选择的路径不是可用目录：${picked}` };
  }

  try {
    await rememberWorkspace(picked, options.memoryFile);
  } catch {
    // 记不住不影响这一次：窗口照常开，代价只是下次还要再问一遍
  }
  return { kind: "ok", root: picked };
}
