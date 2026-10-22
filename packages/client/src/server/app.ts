/**
 * App Server：把内核接上 HTTP + SSE。
 *
 * 它只做三件事——拿请求、调 `WorkspaceHost`、把结果写回去。
 * 所有"跑一次执行"的知识都在内核与宿主里，这里连一次模型调用都不碰，
 * 因此 M5 的 Electron 壳可以直接复用同一个 `AppServer`（只是换个启动者）。
 *
 * 传输层用 express：路由、请求体解析、静态资源都由它负责，
 * 本文件只保留业务语义（哪些端点、什么状态码）。SSE 那一帧仍然自己写
 * ——express 的流式响应只是"不调 res.end()"，帧格式与游标在 `sse.ts`。
 *
 * 工作区是一个**宿主池**（见 docs/client-multi-workspace.md）：
 * 一个根一个 `WorkspaceHost`，可以同时打开几个；"活动根"决定新任务去哪，
 * 切换（聚焦）不销毁别的宿主——旧工作区跑着的任务照常跑完。
 * 会话按根寻址（`?root=`），Run 的 id 进程内唯一、由 AppServer 记住归谁。
 * 只有显式「关闭工作区」才会收掉宿主并取消里面的任务。
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import { HttpError, requireString } from "./errors";
import { WorkspaceHost, errorMessage, type WorkspaceHostOptions } from "./host";
import { errorHandler, localGuard, noStore } from "./http";
import { EventJournal } from "./journal";
import { openSse } from "./sse";
import { isTier, type AppState, type ApprovalAnswer, type ServerEvent, type Tier, type WorkspaceStateView } from "../shared/types";
import type { ServeArgs } from "./serveArgs";
import { logger } from "@minipi/core/shared/logger";
import {
  nullWorkspaceMemory,
  type RememberedWorkspaces,
  type WorkspaceMemory,
} from "./workspaceMemory";

export type AppServerOptions = {
  workspaceRoot: string;
  /** 0 表示让系统分配（测试用）；默认 4788（与设计稿一致） */
  port?: number;
  /** 只监听本机：这个服务没有任何鉴权，绑到 0.0.0.0 等于把 agent 交出去 */
  host?: string;
  webRoot?: string;
  sessionsDir?: string;
  globalAgentsPath?: string;
  tier?: Tier;
  /** 每个 Run 一个隔离 worktree（M3）；默认关——单任务场景多一层检出只是添乱 */
  isolate?: boolean;
  /** worktree 存放根目录，默认 `<tmp>/mini-pi-worktrees` */
  worktreesRoot?: string;
  /** 同时执行上限，默认 1（与 CLI"回合结束后执行"同口径） */
  concurrency?: number;
  /**
   * 同时打开的工作区上限，默认 4。
   *
   * 每个宿主都有自己的 RunManager、技能扫描与 prompt 组装缓存，
   * 不设上限等于让"多开几个项目"悄悄吃光内存；超限时打开请求 409，
   * 让用户先关一个，而不是静默把最早的挤掉。
   */
  maxWorkspaces?: number;
  /**
   * 全局同时执行上限，默认 2。
   *
   * `RunManager` 是每个宿主自己的（默认 1），管不住"4 个工作区各跑一个"；
   * 这道总闸挂在 AppServer 上，宿主开跑前先过它。设为 0 / 负数按默认值处理。
   */
  globalConcurrency?: number;
  resolveModel?: WorkspaceHostOptions["resolveModel"];
  providerService?: WorkspaceHostOptions["providerService"];
  settingsStore?: WorkspaceHostOptions["settingsStore"];
  /**
   * 记住工作区的方式；缺省**不记**（见 `nullWorkspaceMemory`）。
   *
   * 界面切到哪个目录要记下来，桌面壳下次启动才开得对——否则用户在
   * 应用里换了三次工作区，重启一问又回到最初那个。
   */
  workspaceMemory?: WorkspaceMemory;
  /**
   * 应用级事件日志；缺省新建一个。
   *
   * 注入点只给测试（容量调小以覆盖 `gap`）：生产路径永远是默认实例，
   * 它必须挂在 AppServer 上——切工作区换的是 Host，不是"这个应用"。
   */
  journal?: EventJournal;
  now?: () => number;
};

export type RunningAppServer = {
  url: string;
  port: number;
  server: AppServer;
};

const HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_PORT = 4788;
/** 请求体上限：审批参数、提问都在这里，1MB 对"文本"这个用途绰绰有余 */
const MAX_BODY = "1mb";
/** 同时打开的工作区上限（默认值；`maxWorkspaces` 可覆盖） */
const DEFAULT_MAX_WORKSPACES = 4;
/** 全局同时执行上限（默认值；`globalConcurrency` 可覆盖） */
const DEFAULT_GLOBAL_CONCURRENCY = 2;
/** 前端产物在本包内的相对位置（`vite build` 的 outDir） */
const WEB_ROOT_PARTS = ["dist", "web"] as const;

/**
 * 本文件所在目录（即 `src/server`）。
 *
 * 多一层判断是因为 Electron 主进程是 **CJS 产物**：esbuild 打 CJS 时
 * `import.meta` 会被换成空对象，`import.meta.url` 成了 undefined，
 * 直接 `fileURLToPath(undefined)` 就是一次崩溃——而"前端产物没构建"
 * 本该是页面上一句提示，不是进程起不来。
 */
function moduleDir(): string {
  const url = import.meta.url;
  return url ? dirname(dirname(fileURLToPath(url))) : process.cwd();
}

function defaultWebRoot(): string {
  return join(moduleDir(), "..", ...WEB_ROOT_PARTS);
}

/**
 * 判断前端产物是不是在 `candidate` 下。
 *
 * Electron 主进程要自己找它：打包后 `process.cwd()` 可能是任何地方
 * （双击启动时甚至是 `/`），而 `import.meta.url` 在 CJS 产物里也靠不住，
 * 只能拿 Electron 说的应用目录来试。命中返回目录，没命中返回 undefined——
 * 调用方据此决定要不要再往上找一层，或者如实告诉用户"先跑 build:web"。
 */
export function findWebRoot(candidate: string): string | undefined {
  const root = join(candidate, ...WEB_ROOT_PARTS);
  return existsSync(join(root, "index.html")) ? root : undefined;
}

export class AppServer {
  /** 宿主池：绝对路径（已 resolve）→ 宿主。至少一个，上限 `maxWorkspaces` */
  private readonly hosts = new Map<string, WorkspaceHost>();
  /** 活动根：决定"新任务去哪"、输入区与状态行绑定谁 */
  private activeRoot: string | null = null;
  /** runId → 归属工作区：Run 的 id 进程内唯一，跨宿主路由靠它 */
  private readonly runRoots = new Map<string, string>();
  private readonly app: Express = express();
  private readonly options: AppServerOptions;
  private readonly webRoot: string;
  private readonly rememberWorkspace: WorkspaceMemory;
  /**
   * 启动自带的初始根（构造时唯一那个）。它**不是用户的一次明确选择**——
   * serve 的默认当前目录、显式 `--cwd` 都一样——聚焦它不该把它记进
   * 工作区列表，否则"在哪儿敲的命令"就会永久混进列表。
   * 例外：它本来就在记忆里（桌面壳的初始根 = 记忆的 active）时照常记，
   * 活动根要跟上。见 `rememberedRoots`。
   */
  private readonly initialRoot: string;
  /** 记忆列表里已有的根（启动恢复时填入）；空集 = 记忆里没有可用条目 */
  private readonly rememberedRoots = new Set<string>();
  /** 全局 `run_state` / 审批 / 结束事件；正文增量不进来 */
  private readonly journal: EventJournal;
  private readonly maxWorkspaces: number;
  private readonly globalConcurrency: number;
  /** 全局槽位：正在执行的 Run 数与排队等闸的唤醒队列 */
  private globalActive = 0;
  private readonly slotWaiters: Array<() => void> = [];
  private server: Server | null = null;
  /** 进行中的 SSE 连接：关闭服务时要一起断掉，否则进程不退出 */
  private readonly streams = new Set<() => void>();

  constructor(options: AppServerOptions) {
    this.options = options;
    this.webRoot = options.webRoot ?? defaultWebRoot();
    this.rememberWorkspace = options.workspaceMemory ?? nullWorkspaceMemory;
    this.journal = options.journal ?? new EventJournal();
    this.maxWorkspaces =
      Number.isFinite(options.maxWorkspaces) && (options.maxWorkspaces ?? 0) >= 1
        ? Math.floor(options.maxWorkspaces ?? DEFAULT_MAX_WORKSPACES)
        : DEFAULT_MAX_WORKSPACES;
    this.globalConcurrency =
      Number.isFinite(options.globalConcurrency) && (options.globalConcurrency ?? 0) >= 1
        ? Math.floor(options.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY)
        : DEFAULT_GLOBAL_CONCURRENCY;
    const initial = WorkspaceHost.assertWorkspaceRoot(options.workspaceRoot);
    this.initialRoot = initial;
    this.hosts.set(initial, this.createHost(initial, options.tier));
    this.activeRoot = initial;
    this.registerRoutes();
  }

  get workspaceRoot(): string {
    return this.requiredActiveHost().workspaceRoot;
  }

  /** 池里至少有一个工作区（构造时必建，关闭最后一个被 409 挡住） */
  private requiredActiveHost(): WorkspaceHost {
    const host = this.activeRoot !== null ? this.hosts.get(this.activeRoot) : undefined;
    if (!host) {
      throw new HttpError(409, "没有打开的工作区");
    }
    return host;
  }

  /** 有活动根就用它；没有返回 null（启动路径不会走到，路由会） */
  private activeHost(): WorkspaceHost | null {
    return this.activeRoot !== null ? (this.hosts.get(this.activeRoot) ?? null) : null;
  }

  /**
   * 打开（或聚焦）一个工作区。
   *
   * 语义与旧版"切换"的关键差别：**不销毁**别的宿主——A 项目的任务跑着，
   * 聚焦到 B 去看一眼，A 的任务照常跑完。已打开的根重复打开只是挪焦点。
   */
  async openWorkspace(candidate: string): Promise<void> {
    const root = WorkspaceHost.assertWorkspaceRoot(candidate);
    if (this.hosts.has(root)) {
      // 重复打开当前活动根不算一次选择：没有换焦点，也就没有可记的
      if (this.activeRoot === root) {
        return;
      }
      this.activeRoot = root;
      await this.remember(root);
      return;
    }
    if (this.hosts.size >= this.maxWorkspaces) {
      throw new HttpError(
        409,
        `最多同时打开 ${this.maxWorkspaces} 个工作区，先关闭一个再打开新的`,
      );
    }
    const current = this.activeHost();
    // 新宿主沿用用户当前的档位与隔离开关：这些是"人的选择"，
    // 换个工作区不该悄悄复位
    const next = this.createHost(
      root,
      current?.getTier(),
      current?.getIsolate(),
    );
    await next.start();
    this.hosts.set(root, next);
    this.activeRoot = root;
    await this.remember(root);
  }

  /** 旧名字保留：语义已是"打开/聚焦"，调用方逐步迁到 `openWorkspace` */
  async switchWorkspace(candidate: string): Promise<void> {
    await this.openWorkspace(candidate);
  }

  /**
   * 显式关闭一个工作区。
   *
   * 里面还有任务在跑 / 排队 / 等裁决时拒绝——"切走不打断"的另一面是
   * "关闭才打断"，这条打断必须由用户显式发起，不能被顺手触发。
   * 关闭最后一个工作区同样拒绝：池空会让 `workspace` 变 null，
   * 界面的空态引导在"重新打开"这条路上，不在"服务还在但没有工作区"上。
   *
   * 关成的同时把这条从工作区记忆里摘掉：用户显式关掉的目录不该在
   * 下次启动时又被恢复出来。摘记忆放在收宿主**之前**（先落盘再改内存），
   * 中间崩掉最多是"没关成"，不会是"关了又复活"。
   */
  async closeWorkspace(candidate: string): Promise<void> {
    const root = resolve(candidate);
    const host = this.hosts.get(root);
    if (!host) {
      throw new HttpError(404, `这个工作区没有打开：${root}`);
    }
    if (this.hosts.size === 1) {
      throw new HttpError(409, "至少保留一个工作区：先打开别的，再关这个");
    }
    if (host.hasActiveRun()) {
      throw new HttpError(409, "这个工作区还有任务在跑，先停止它们再关闭");
    }
    await this.forget(root);
    host.close();
    this.hosts.delete(root);
    for (const [runId, owner] of [...this.runRoots]) {
      if (owner === root) {
        this.runRoots.delete(runId);
      }
    }
    if (this.activeRoot === root) {
      this.activeRoot = [...this.hosts.keys()][0] ?? null;
    }
  }

  async start(): Promise<RunningAppServer> {
    await this.requiredActiveHost().start();
    const port = this.options.port ?? DEFAULT_PORT;
    const host = this.options.host ?? "127.0.0.1";
    const server = await new Promise<Server>((resolve, reject) => {
      const created = this.app.listen(port, host, () => resolve(created));
      created.once("error", reject);
    });
    this.server = server;
    const address = server.address();
    const actual = typeof address === "object" && address ? address.port : port;
    return {
      url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actual}`,
      port: actual,
      server: this,
    };
  }

  async stop(): Promise<void> {
    for (const close of [...this.streams]) {
      close();
    }
    this.streams.clear();
    for (const host of this.hosts.values()) {
      host.close();
    }
    this.hosts.clear();
    this.activeRoot = null;
    this.runRoots.clear();
    this.journal.clear();
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ------------------------------------------------------- 宿主寻址

  /**
   * 会话类端点的宿主解析：带 `?root=` 按根找，不带就落在活动根。
   *
   * sessionId 是会话文件名，跨工作区会撞——所有会话读写必须先过这里，
   * 漏一处就是把 A 项目的会话读成 B 项目的（静默出错）。
   */
  private hostForRoot(raw: string | undefined): WorkspaceHost {
    if (raw === undefined || typeof raw !== "string" || raw.length === 0) {
      return this.requiredActiveHost();
    }
    const host = this.hosts.get(resolve(raw));
    if (!host) {
      throw new HttpError(404, `这个工作区没有打开：${raw}`);
    }
    return host;
  }

  /** Run 类端点的宿主解析：runId 进程内唯一，先查登记表，兜底扫一遍池 */
  private hostForRun(runId: string): WorkspaceHost {
    const root = this.runRoots.get(runId);
    if (root) {
      const host = this.hosts.get(root);
      if (host) {
        return host;
      }
    }
    for (const host of this.hosts.values()) {
      try {
        host.record(runId);
        return host;
      } catch {
        // 不在这个宿主上，继续找
      }
    }
    throw new HttpError(404, `任务不存在：${runId}`);
  }

  /** 审批裁决的路由：审批 id 只有挂着的那个宿主认识 */
  private hostForApproval(id: string): WorkspaceHost {
    for (const host of this.hosts.values()) {
      if (host.hasApproval(id)) {
        return host;
      }
    }
    throw new HttpError(409, "这条审批已失效（可能已裁决，或任务已结束）");
  }

  // ------------------------------------------------------- 全局并发

  /** 等一个全局执行槽位；返回释放函数（必须调用，否则闸永远不松） */
  private acquireRunSlot(): Promise<() => void> {
    if (this.globalActive < this.globalConcurrency) {
      this.globalActive += 1;
      return Promise.resolve(() => this.releaseRunSlot());
    }
    return new Promise((resolveWait) => {
      this.slotWaiters.push(() => {
        this.globalActive += 1;
        resolveWait(() => this.releaseRunSlot());
      });
    });
  }

  private releaseRunSlot(): void {
    const next = this.slotWaiters.shift();
    if (next) {
      // 直接把槽位移交给下一个等待者：不经过"先减再加"，
      // 中间不会漏进第三个 Run
      next();
      return;
    }
    this.globalActive = Math.max(0, this.globalActive - 1);
  }

  /**
   * 记下这次选择，供桌面壳下次启动使用。
   *
   * 启动自带的初始根不在此列（见 `initialRoot`）：它是 serve 的默认
   * 当前目录或一次性的 `--cwd`，不是"我要把这个目录加进工作区"——
   * 默默记下它，列表就会被"在哪儿敲的命令"越积越脏。它已经在记忆里时
   * （桌面壳形状）照常记，聚焦切换要能更新 `active`。
   *
   * 失败**不影响切换本身**：宿主已经换过来了，会话在跑、页面能用，
   * 唯独"下次自动开这个目录"这条会失效。为一条便利功能把一次成功的
   * 切换报成失败是不划算的，因此只把原因写进日志。
   */
  private async remember(root: string): Promise<void> {
    if (root === this.initialRoot && !this.rememberedRoots.has(root)) {
      return;
    }
    try {
      await this.rememberWorkspace.remember(root);
    } catch (error) {
      logger.error("记住工作区失败（不影响本次切换）:", errorMessage(error));
    }
  }

  /** 关闭工作区时把这条从记忆里摘掉；失败同样不影响关闭本身 */
  private async forget(root: string): Promise<void> {
    try {
      await this.rememberWorkspace.forget(root);
    } catch (error) {
      logger.error("移除工作区记忆失败（不影响本次关闭）:", errorMessage(error));
    }
  }

  /**
   * 启动恢复：把记忆里的工作区逐一开进池子（`bootAppServer` 在入口接了
   * 记忆时调用）。
   *
   * - **活动根不在这里挪**：桌面壳的初始根本来就取自记忆的 `active`
   *   （`resolveDesktopWorkspace` → `readRememberedWorkspace`），显式
   *   `--cwd` 指定的更是不能被记忆压过去——恢复只负责"把其余的加进来"；
   * - 目录已失效的条目**跳过并摘除**：侧栏只显示打开的宿主，一条永远
   *   开不出来的隐形记忆只会让人困惑；摘除前先写日志，不是静默清除；
   * - 目录有效但起宿主失败的（比如会话目录暂时不可写）只跳过、**保留**
   *   记忆：路径还在，下次启动再试；
   * - 超出同时打开上限的也保留：这是"这次没开"，不是"不再要了"。
   */
  async restoreWorkspaces(remembered: RememberedWorkspaces): Promise<void> {
    // 先记下记忆里有哪些根：初始根在其中时（桌面壳形状）聚焦它要照常
    // 更新 active，不能被"启动自带的不记"规则误伤
    for (const root of remembered.roots) {
      this.rememberedRoots.add(root);
    }
    for (const root of remembered.roots) {
      if (this.hosts.has(root)) {
        continue;
      }
      let usable = true;
      try {
        WorkspaceHost.assertWorkspaceRoot(root);
      } catch {
        usable = false;
      }
      if (!usable) {
        logger.error(`启动恢复：记忆里的工作区已不可用，跳过并移除：${root}`);
        await this.forget(root);
        continue;
      }
      if (this.hosts.size >= this.maxWorkspaces) {
        logger.error(
          `启动恢复：已到同时打开上限（${this.maxWorkspaces}），这条记忆这次没有打开：${root}`,
        );
        continue;
      }
      const current = this.activeHost();
      // 与打开工作区同一套继承：档位与隔离开关是"人的选择"，换工作区不复位
      const host = this.createHost(root, current?.getTier(), current?.getIsolate());
      try {
        await host.start();
      } catch (error) {
        logger.error(`启动恢复：打开工作区失败，跳过（记忆保留）：${root}`, errorMessage(error));
        continue;
      }
      this.hosts.set(root, host);
    }
  }

  private createHost(workspaceRoot: string, tier?: Tier, isolate?: boolean): WorkspaceHost {
    return new WorkspaceHost({
      workspaceRoot,
      ...(this.options.sessionsDir ? { sessionsDir: this.options.sessionsDir } : {}),
      ...(this.options.globalAgentsPath ? { globalAgentsPath: this.options.globalAgentsPath } : {}),
      ...(tier ? { tier } : {}),
      // 打开工作区时沿用用户当前的开关；没给才回落到启动参数
      ...((isolate ?? this.options.isolate ?? false) ? { isolate: true } : {}),
      ...(this.options.worktreesRoot ? { worktreesRoot: this.options.worktreesRoot } : {}),
      ...(this.options.concurrency !== undefined
        ? { concurrency: this.options.concurrency }
        : {}),
      ...(this.options.resolveModel ? { resolveModel: this.options.resolveModel } : {}),
      ...(this.options.providerService ? { providerService: this.options.providerService } : {}),
      ...(this.options.settingsStore ? { settingsStore: this.options.settingsStore } : {}),
      // Host 只负责把控制事件交出来；日志归 AppServer，切工作区时不跟着换。
      // root 跟着宿主走：每条控制事件都标上它属于哪个工作区
      onRunEvent: (runId, event) => this.journal.push(runId, event, workspaceRoot),
      // 多工作区的总闸；单工作区时池里只有一个宿主，等于不设限
      acquireRunSlot: () => this.acquireRunSlot(),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
  }

  // --------------------------------------------------------------- 状态

  /**
   * 聚合全部宿主的状态。
   *
   * 顶层字段（workspace / tier / model / sessions…）仍然是**活动根**的——
   * 单工作区用法的形状不变；多出来的 `workspaces[]` 是池里每个根自己的
   * 会话、任务与待裁决数，`runs` 则是跨根汇总（各带 `root`）。
   */
  private async composeState(): Promise<AppState> {
    const states = new Map<string, Awaited<ReturnType<WorkspaceHost["state"]>>>();
    for (const [root, host] of this.hosts) {
      states.set(root, await host.state());
    }
    const activeRoot = this.activeRoot ?? [...this.hosts.keys()][0] ?? null;
    const active = activeRoot !== null ? states.get(activeRoot) : undefined;

    const workspaces: WorkspaceStateView[] = [...states.entries()].map(([root, s]) => ({
      root,
      name: s.workspace.name,
      sessions: s.sessions,
      runs: s.runs.map((run) => ({ ...run, root })),
      currentSessionId: s.currentSessionId,
      approvals: { pending: s.approvals.pending },
      sendable: s.sendable,
      blockReason: s.blockReason,
      isolate: s.isolate,
      isolateError: s.isolateError,
    }));

    // 审批跨根聚合：待裁决数求和，最早挂起的那个仍是跳转的落脚点
    // （前端拿 runs 里的 root 把 runId 映射回工作区）
    const approvals = [...this.hosts.entries()].flatMap(([root, host]) =>
      host.listApprovals().map((request) => ({ ...request, root })),
    );
    approvals.sort((a, b) => a.createdAt - b.createdAt);

    return {
      workspace: active?.workspace ?? { root: "", name: "" },
      workspaces,
      activeRoot: activeRoot ?? "",
      tier: active?.tier ?? "workspace-write",
      model:
        active?.model ?? {
          provider: null,
          model: null,
          label: null,
          contextWindow: 0,
          contextWindowSource: "default",
        },
      approvals: { pending: approvals.length, oldestRunId: approvals[0]?.runId ?? null },
      runs: workspaces
        .flatMap((w) => w.runs)
        .sort((a, b) => b.startedAt - a.startedAt),
      sessions: active?.sessions ?? [],
      currentSessionId: active?.currentSessionId ?? null,
      sendable: active?.sendable ?? false,
      // 不能用 ?? ：blockReason 为 null（可以发送）会被当成"没有值"吞掉
      blockReason: active ? active.blockReason : "没有打开的工作区",
      subAgent: active?.subAgent ?? false,
      isolate: active?.isolate ?? false,
      isolateError: active?.isolateError ?? null,
    };
  }

  // --------------------------------------------------------------- 路由

  private registerRoutes(): void {
    const app = this.app;
    // 关掉 express 的默认行为：这个服务没有代理在前面，`X-Powered-By` 只是白送信息
    app.disable("x-powered-by");
    app.use(localGuard);
    app.use(express.json({ limit: MAX_BODY }));
    app.use("/api", noStore);

    app.get("/api/state", wrap(async (_req, res) => {
      res.json(await this.composeState());
    }));

    // 所有工作区的 Run 汇总（各带 root）；单工作区时就是原来那一份
    app.get("/api/runs", wrap(async (_req, res) => {
      res.json((await this.composeState()).runs);
    }));

    app.post("/api/runs", wrap((req, res) => {
      const payload = asRecord(req.body);
      const prompt = requireString(payload.prompt, "prompt");
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
      const root = typeof payload.root === "string" && payload.root.length > 0
        ? payload.root
        : undefined;
      const host = this.hostForRoot(root);
      const created = host.send(prompt, sessionId);
      // 登记归属：之后这条 Run 的查询 / 取消 / 事件流都按它路由
      this.runRoots.set(created.runId, host.workspaceRoot);
      res.status(201).json(created);
    }));

    app.get("/api/runs/:id", wrap((req, res) => {
      res.json(this.hostForRun(pathParam(req.params.id)).runSummary(pathParam(req.params.id)));
    }));

    app.post("/api/runs/:id/cancel", wrap((req, res) => {
      this.hostForRun(pathParam(req.params.id)).cancel(pathParam(req.params.id));
      res.status(204).end();
    }));

    // 丢弃这个 Run 的隔离工作区（界面审批卡的「丢弃」）。跑着的时候
    // 宿主会 409——正在用的目录不能抽掉；没开隔离同样是 409，而不是
    // 假装删掉了什么
    app.delete("/api/runs/:id/worktree", wrap((req, res) => {
      this.hostForRun(pathParam(req.params.id)).releaseWorktree(pathParam(req.params.id));
      res.status(204).end();
    }));

    // 隔离改动的审阅与落地：先看 diff，再决定合并还是丢弃
    app.get("/api/runs/:id/diff", wrap((req, res) => {
      res.json(this.hostForRun(pathParam(req.params.id)).runDiff(pathParam(req.params.id)));
    }));

    app.post("/api/runs/:id/merge", wrap((req, res) => {
      res.json(this.hostForRun(pathParam(req.params.id)).mergeWorktree(pathParam(req.params.id)));
    }));

    app.get("/api/runs/:id/events", (req, res, next) => {
      try {
        this.streamEvents(req, res);
      } catch (error) {
        next(error);
      }
    });

    // 应用级事件流：所有 Run 的控制事件（见 docs/client-event-stream.md）。
    // 与 per-run 流并存：正文与工具卡仍走那一条，这条只回答"别的任务怎么了"
    app.get("/api/events", (req, res, next) => {
      try {
        this.streamJournal(req, res);
      } catch (error) {
        next(error);
      }
    });

    // 审批跨根聚合，各带 root；裁决按 id 路由到挂着的那个宿主
    app.get("/api/approvals", wrap((_req, res) => {
      const all = [...this.hosts.entries()].flatMap(([root, host]) =>
        host.listApprovals().map((request) => ({ ...request, root })),
      );
      all.sort((a, b) => a.createdAt - b.createdAt);
      res.json(all);
    }));

    app.post("/api/approvals/:id", wrap((req, res) => {
      const answer = asRecord(req.body).answer;
      if (answer !== "yes" && answer !== "no" && answer !== "always") {
        throw new HttpError(400, `无法识别的裁决：${String(answer)}`);
      }
      const host = this.hostForApproval(pathParam(req.params.id));
      res.json(host.resolveApproval(pathParam(req.params.id), answer as ApprovalAnswer));
    }));

    // 会话按根寻址：sessionId 是文件名，跨工作区会撞（见 docs/client-multi-workspace.md §4）
    app.get("/api/sessions", wrap((req, res) => {
      res.json(this.hostForRoot(queryParam(req.query.root)).listSessions());
    }));

    // 没有"新建会话"这个接口：会话在第一次发送时创建（POST /api/runs
    // 不带 sessionId），界面上点「新任务」因此不会往磁盘上写空文件

    app.get("/api/sessions/:id", wrap(async (req, res) => {
      const host = this.hostForRoot(queryParam(req.query.root));
      res.json(await host.readSession(pathParam(req.params.id)));
    }));

    app.delete("/api/sessions/:id", wrap(async (req, res) => {
      const host = this.hostForRoot(queryParam(req.query.root));
      res.json(await host.deleteSession(pathParam(req.params.id)));
    }));

    app.get("/api/providers", wrap(async (_req, res) => {
      res.json(await this.requiredActiveHost().providers());
    }));

    // 只存凭据、不设默认模型：自定义供应商先"能进"，再选模型
    app.post("/api/providers", wrap(async (req, res) => {
      const host = this.requiredActiveHost();
      await host.configureProvider(asRecord(req.body));
      res.json(await host.providers());
    }));

    app.delete("/api/providers/:name", wrap(async (req, res) => {
      const host = this.requiredActiveHost();
      await host.deleteCustomProvider(pathParam(req.params.name));
      res.json(await this.composeState());
    }));

    app.get("/api/models", wrap(async (req, res) => {
      const provider = req.query.provider;
      if (typeof provider !== "string" || provider.length === 0) {
        throw new HttpError(400, "缺少 provider 参数");
      }
      res.json(await this.requiredActiveHost().models(provider));
    }));

    app.post("/api/model", wrap(async (req, res) => {
      const host = this.requiredActiveHost();
      await host.configureModel(asRecord(req.body));
      res.json(await this.composeState());
    }));

    app.post("/api/tier", wrap((req, res) => {
      const payload = asRecord(req.body);
      if (!isTier(payload.tier)) {
        throw new HttpError(400, `无法识别的审批档位：${String(payload.tier)}`);
      }
      // 档位是"人的选择"，对池里所有宿主生效：设置面板只有一个开关，
      // 不该出现"A 工作区问、B 工作区不问"这种看不懂的组合
      for (const host of this.hosts.values()) {
        host.setTier(payload.tier);
      }
      res.json({ tier: this.requiredActiveHost().getTier() });
    }));

    app.post("/api/options", wrap(async (req, res) => {
      const payload = asRecord(req.body);
      if (payload.subAgent !== undefined) {
        // 委派开关同理：对所有宿主生效，与设置里的同一份语义
        for (const host of this.hosts.values()) {
          host.setSubAgentEnabled(payload.subAgent);
        }
      }
      if (payload.isolate !== undefined) {
        // 不支持时这里 409 并带上原因；state 里的 isolateError 也会同时更新。
        // 隔离按宿主探测（有的目录不是 git 仓库），只作用于活动根
        this.requiredActiveHost().setIsolate(payload.isolate);
      }
      res.json(await this.composeState());
    }));

    app.get("/api/dirs", wrap((req, res) => {
      const path = req.query.path;
      res.json(this.requiredActiveHost().listDir(typeof path === "string" ? path : null));
    }));

    // 打开（或聚焦）一个工作区：不销毁别的宿主，切走不打断跑着的任务
    app.post("/api/workspace", wrap(async (req, res) => {
      const root = requireString(asRecord(req.body).path, "path");
      await this.openWorkspace(root);
      res.json((await this.requiredActiveHost().state()).workspace);
    }));

    // 显式关闭：跑着任务时 409——只有这条路径才结束里面的任务
    app.delete("/api/workspace", wrap(async (req, res) => {
      const root = queryParam(req.query.root) || requireString(asRecord(req.body).root, "root");
      await this.closeWorkspace(root);
      res.status(204).end();
    }));

    // API 里没有匹配到的：明确的 404，而不是掉进静态资源兜底返回一页 HTML
    app.use("/api", (_req, res) => {
      res.status(404).json({
        error: `没有这个接口：${_req.method} ${_req.originalUrl}`,
        status: 404,
      });
    });

    // 静态资源只接受 GET：POST 到一个页面路径不是"找不到"，是方法不对
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.status(405).json({ error: "静态资源只支持 GET", status: 405 });
        return;
      }
      next();
    });

    app.use(
      express.static(this.webRoot, {
        setHeaders: (res) => {
          // 前端产物没有指纹，开发期改完要立刻生效；代价是每次都回源，本地无所谓
          res.set("Cache-Control", "no-cache");
        },
      }),
    );

    // 单页应用：未知路径回落到 index.html，刷新深链接不至于 404
    app.use((_req, res) => {
      const index = join(this.webRoot, "index.html");
      if (existsSync(index)) {
        res.set("Cache-Control", "no-cache");
        res.sendFile(index);
        return;
      }
      res
        .status(404)
        .type("text/plain; charset=utf-8")
        .send("客户端产物还没构建。先运行 pnpm --filter @minipi/client run build:web\n");
    });

    app.use(errorHandler);
  }

  // --------------------------------------------------------------- SSE

  /**
   * 事件流。
   *
   * `cursor` 是客户端已收到的最后一个 seq：刷新页面、切回任务、断线重连
   * 都靠它补齐，而不是让前端自己攒一份"我收到哪了"。
   */
  private streamEvents(req: Request, res: Response): void {
    const runId = pathParam(req.params.id);
    const record = this.hostForRun(runId).record(runId);
    const raw = req.query.cursor;
    const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
    const cursor = text === undefined ? 0 : Math.max(0, Math.floor(Number(text) || 0));

    const stream = openSse(res);
    const backlog = record.since(cursor);
    if (backlog.gap) {
      const gap: ServerEvent = {
        type: "stream_gap",
        firstSeq: record.firstSeq,
        lastSeq: record.lastSeq,
      };
      stream.send({ seq: cursor, event: gap });
    }
    for (const item of backlog.items) {
      stream.send(item);
    }

    const unsubscribe = record.subscribe((item) => {
      stream.send(item);
      if (item.event.type === "run_done") {
        // 让最后一帧先落到客户端，再收连接
        setTimeout(() => teardown(), 50);
      }
    });

    const heartbeat = setInterval(() => {
      if (!stream.ping()) {
        teardown();
      }
    }, HEARTBEAT_INTERVAL_MS);
    // 心跳不该拖住进程退出
    heartbeat.unref?.();

    let closed = false;
    const teardown = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      this.streams.delete(teardown);
      stream.end();
    };

    this.streams.add(teardown);
    req.on("close", teardown);
    req.on("error", teardown);
  }

  /**
   * 应用级事件流。
   *
   * 与 per-run 流的差别只有三点：`data` 里多一层 `runId`、`id` 是应用级序号、
   * 不因 `run_done` 收连接。断线由前端带游标重连，缺口用 `stream_gap` 明说。
   */
  private streamJournal(req: Request, res: Response): void {
    const raw = req.query.cursor;
    const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
    // 不带游标 = 从当前末尾开始：首屏已经拿过 `/api/state`，没必要再重放一遍
    const cursor =
      text === undefined ? this.journal.lastSeq : Math.max(0, Math.floor(Number(text) || 0));

    const stream = openSse(res);
    const backlog = this.journal.since(cursor);
    if (backlog.gap) {
      stream.sendEnvelope({
        seq: cursor,
        runId: "",
        event: {
          type: "stream_gap",
          firstSeq: this.journal.firstSeq,
          lastSeq: this.journal.lastSeq,
        },
      });
    }
    for (const entry of backlog.items) {
      stream.sendEnvelope(entry);
    }
    // 补历史放完再告诉前端"可以开始提醒了"：否则刷新页面会把旧的挂起重新弹一遍
    stream.sendEnvelope({
      seq: this.journal.lastSeq,
      runId: "",
      event: { type: "journal_ready" },
    });

    const unsubscribe = this.journal.subscribe((entry) => stream.sendEnvelope(entry));

    const heartbeat = setInterval(() => {
      if (!stream.ping()) {
        teardown();
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    let closed = false;
    const teardown = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      this.streams.delete(teardown);
      stream.end();
    };

    this.streams.add(teardown);
    req.on("close", teardown);
    req.on("error", teardown);
  }
}

/**
 * `serve` 与 Electron 主进程（M5）共用的装配。
 *
 * 抽出来不是为了省几行，而是为了**只有一条启动路径**：桌面壳与命令行是
 * 同一个服务的两种开法，各写一份的结果一定是两边慢慢分叉（一边加了
 * `--isolate` 而另一边没有，用户只会认为桌面版是残缺版）。
 *
 * 失败时**返回码**而不是抛：调用方有两种（进程入口要退出码、桌面壳要
 * 决定"还开不开窗口"），抛异常会逼它们各自写一份 try/catch。
 */
export type BootOptions = ServeArgs &
  Omit<AppServerOptions, "workspaceRoot" | "port" | "host" | "isolate" | "concurrency">;

export type BootStreams = {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

export type BootResult = {
  code: number;
  server: AppServer | null;
  url: string | null;
  port: number | null;
};

export async function bootAppServer(
  options: BootOptions,
  streams: BootStreams,
): Promise<BootResult> {
  let root: string;
  try {
    root = WorkspaceHost.assertWorkspaceRoot(options.cwd);
  } catch (error) {
    streams.stderr.write(`mini-pi 客户端：工作区不可用：${errorMessage(error)}\n`);
    return { code: 1, server: null, url: null, port: null };
  }

  const server = new AppServer({
    workspaceRoot: root,
    port: options.port,
    host: options.host,
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
    ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
    ...(options.globalAgentsPath ? { globalAgentsPath: options.globalAgentsPath } : {}),
    ...(options.tier ? { tier: options.tier } : {}),
    ...(options.isolate ? { isolate: true } : {}),
    ...(options.worktreesRoot ? { worktreesRoot: options.worktreesRoot } : {}),
    ...(options.resolveModel ? { resolveModel: options.resolveModel } : {}),
    ...(options.providerService ? { providerService: options.providerService } : {}),
    ...(options.settingsStore ? { settingsStore: options.settingsStore } : {}),
    // 入口显式给才记：bootAppServer 自己不定默认值，否则单测调它就会
    // 往用户家目录里写文件
    ...(options.workspaceMemory ? { workspaceMemory: options.workspaceMemory } : {}),
    ...(options.now ? { now: options.now } : {}),
    concurrency: options.concurrency,
  });
  // 启动恢复：入口接了记忆才做（桌面壳 / serve 都接）。读取失败不影响
  // 本次启动——记忆是便利功能，不该有把服务挡在门外的话语权。
  if (options.workspaceMemory) {
    try {
      const remembered = await options.workspaceMemory.list();
      if (remembered) {
        await server.restoreWorkspaces(remembered);
      }
    } catch (error) {
      logger.error(`启动恢复：读取工作区记忆失败（不影响本次启动）: ${errorMessage(error)}`);
    }
  }
  const running = await server.start();
  return { code: 0, server, url: running.url, port: running.port };
}

/**
 * 把 handler 里的同步 throw 与 rejected promise 都送进 express 的错误管道。
 *
 * express 5 已经会自动捕获 async 抛错，但这条链路（404 的 Run、非法档位）
 * 是"用户看得见的失败"，不该依赖某一个大版本的隐式行为。
 */
function wrap(
  handler: (req: Request, res: Response) => void | Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    try {
      const result = handler(req, res);
      if (result instanceof Promise) {
        result.catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
}

/**
 * 路径参数。
 *
 * `@types/express` 允许同名参数出现多次（`string | string[]`），
 * 而这些 id（runId / sessionId / approvalId）本来就不该是数组——
 * 取第一个即可，取不到就是空串，交给宿主报 404。
 */
function pathParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

/** query 参数（`?root=` 这类可选寻址）：取第一个，缺省空串 */
function queryParam(value: unknown): string {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : "";
  }
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}
