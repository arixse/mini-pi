/**
 * 一个工作区的宿主：模型、会话、工具、Run 与审批的装配处。
 *
 * 这是 CLI 里 `main()` 那段启动编排的服务端镜像，但有两处**故意不同**：
 *
 * 1. **不自动创建默认配置**。CLI 在没有 `defaultModel` 时会挑第一个有
 *    apiKey 的供应商、把 `provider/model` 写回 settings.json；客户端不这么做——
 *    界面有空态引导（"选工作区、配模型"），静默改写用户的配置文件反而
 *    会覆盖他刚做过的选择。
 * 2. **会话是显式参数**，不是"进程里那一个当前会话"。多个 Run 并行时
 *    "当前会话"这个词没有意义，服务端必须每处都问一句"哪个会话"。
 *
 * 内核不在这里被改造：Run / RunManager / ApprovalBroker 都是现成的，
 * 这个类只负责把它们的入参从"进程全局状态"翻译成"请求参数"。
 */

import { basename, dirname, join, resolve } from "node:path";
import { readdirSync, rmSync, statSync } from "node:fs";
import { createModelFromProvider, type LlmModel } from "@minipi/core/agent/model";
import { createToolRegistry, READ_ONLY_TOOLS } from "@minipi/core/agent/tools/registry";
import type { ToolRegistry } from "@minipi/core/agent/tools/registry";
import {
  SubAgentRuntimeProvider,
  createSubAgentTool,
} from "@minipi/core/agent/subagentTool";
import { workspaceFileExists } from "@minipi/core/agent/tools/workspace";
import { SkillLoader } from "@minipi/core/agent/skillLoader";
import { SessionManager } from "@minipi/core/agent/sessionManager";
import { JsonlSessionStore } from "@minipi/core/agent/sessionStore";
import { createUserMessage } from "@minipi/core/agent/message";
import type { AgentEvent, AgentMessage } from "@minipi/core/shared/protocol";
import type { BeforeToolCall, ToolCallContext } from "@minipi/core/agent/loop";
import type { ToolDecision } from "@minipi/core/agent/loop";
import { buildSystemPrompt } from "@minipi/core/prompt";
import { detectProjectStack, formatProjectStack } from "@minipi/core/projectStack";
import { assessToolRisk } from "@minipi/core/risk";
import { describeToolCallLines } from "@minipi/core/toolSummary";
// 三档裁决表在内核里，且只有一份：服务端与 CLI 调的是同一个函数
import { evaluateApprovalPolicy } from "@minipi/core/policy";
import { appendAgentMessages, appendUserMessage, compactIfNeeded } from "@minipi/core/session";
import { KEEP_RECENT_MESSAGES, contextOverheadTokens, resolveContextBudget } from "@minipi/core/context";
import {
  ModelProviderService,
  SettingsStore,
  resolveContextWindow,
  type ContextWindowSource,
} from "@minipi/core/provider";
import { newRunId, type RunResult } from "@minipi/core/run";
import { RunManager } from "@minipi/core/runManager";
import { WorkspaceManager, type Workspace } from "@minipi/core/worktree";
import { logger } from "@minipi/core/shared/logger";
import { ApprovalBroker, newApprovalId } from "./broker";
import { HttpError } from "./errors";
import { isRunMetaEvent } from "./journal";
import { previewToolArgs } from "../shared/preview";
import { RunRecord } from "./runs";
import { readSessionMeta } from "./sessionMeta";
import {
  isTier,
  type AppState,
  type ApprovalAnswer,
  type ApprovalRequest,
  type DirListing,
  type ProviderView,
  type RunDiff,
  type RunPhase,
  type RunSummary,
  type ServerEvent,
  type SessionDetail,
  type SessionSummary,
  type Tier,
} from "../shared/types";

/** 模型解析的结果：三个字段一起用，单独看任何一个都答不出"用谁在跑" */
export type ResolvedModel = {
  model: LlmModel | null;
  providerName: string | null;
  modelName: string | null;
};

export type WorkspaceHostOptions = {
  workspaceRoot: string;
  /** 会话目录，默认 ~/.mini-pi/sessions（测试注入临时目录） */
  sessionsDir?: string;
  globalAgentsPath?: string;
  tier?: Tier;
  /** 同时执行上限，默认 1（与 CLI"回合结束后执行"同口径） */
  concurrency?: number;
  /**
   * 每个 Run 一个隔离的 git worktree（M3）。
   *
   * 并行跑多个任务时，共用一个根目录意味着两个 Run 会同时写同一批文件。
   * 开了它，`execute` 会为每个 Run 建一份独立检出；隔离不可用（没装 git、
   * 不在仓库里、仓库没有提交）时**发送直接报错**，不静默退回共用目录。
   */
  isolate?: boolean;
  /** worktree 存放根目录，默认 `<tmp>/mini-pi-worktrees` */
  worktreesRoot?: string;
  /**
   * 模型解析的注入点。
   *
   * 真实实现要读 `~/.mini-pi/auth.json` 并构造 SDK 客户端，单测里
   * 既不该碰用户的凭据、也不该真的发请求，所以整条链路都可替换。
   */
  resolveModel?: (service: ModelProviderService, settings: SettingsStore) => Promise<ResolvedModel>;
  /**
   * 配置存储的注入点。
   *
   * 不注入时读写 `~/.mini-pi/`——单测里那是用户的真实凭据，
   * 既不该被读、更不该被写，所以整条存储链也要可替换。
   */
  providerService?: ModelProviderService;
  settingsStore?: SettingsStore;
  /**
   * 控制事件的旁路出口：AppServer 用它喂应用级日志（`/api/events`）。
   *
   * 只送 `isRunMetaEvent` 认可的那几类；正文增量仍然只走 per-run 流。
   */
  onRunEvent?: (runId: string, event: ServerEvent) => void;
  now?: () => number;
};

/** 会话的内存投影：文件是唯一事实来源，这里只是它的形状 */
type SessionContext = {
  store: JsonlSessionStore;
  messages: AgentMessage[];
};

/** 侧栏最多显示多少个 Run：再多的历史属于会话列表，不属于"进行中" */
const MAX_RUNS = 50;

export class WorkspaceHost {
  readonly workspaceRoot: string;

  private readonly providerService: ModelProviderService;
  private readonly settingsStore: SettingsStore;
  private readonly skillLoader: SkillLoader;
  private readonly sessionManager: SessionManager;
  private readonly runManager: RunManager;
  private readonly broker = new ApprovalBroker();
  /** 隔离工作区管理器；即使当前没开隔离也创建，开关与历史 Run 的丢弃都要用它 */
  private readonly workspaces: WorkspaceManager;
  /** 下一次执行是否隔离；运行中切换只影响之后的任务 */
  private isolate: boolean;
  /** 隔离不可用的原因（探测过一次就记下，发送时照着报错） */
  private isolationError: string | null = null;
  private readonly resolveModelImpl: NonNullable<WorkspaceHostOptions["resolveModel"]>;
  private readonly onRunEvent: ((runId: string, event: ServerEvent) => void) | undefined;
  private readonly now: () => number;

  private readonly records = new Map<string, RunRecord>();
  /** 每个会话一条串行链：同一会话里后发的消息排在前面那个之后 */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly sessions = new Map<string, SessionContext>();
  private readonly metaCache = new Map<string, { sizeBytes: number; summary: SessionSummary }>();
  /** 选了"本会话内全部允许"的会话（与 CLI 的 `a` 同义：不是全局、不是本轮） */
  private readonly trustedSessions = new Set<string>();

  private tier: Tier;
  private currentSessionId: string | null = null;
  private model: LlmModel | null = null;
  private providerName: string | null = null;
  private modelName: string | null = null;
  private contextWindow: number;
  private contextWindowSource: ContextWindowSource = "default";
  private modelError: string | null = null;
  /** 委派开关：默认沿用 settings.json（与 CLI 的 /subagent 同一份配置） */
  private subAgentEnabled = false;
  /** 展示用注册表：只为了拿工具定义算固定开销，不参与执行 */
  private demoRegistry: ToolRegistry | null = null;

  constructor(options: WorkspaceHostOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.tier = options.tier ?? "workspace-write";
    this.now = options.now ?? (() => Date.now());
    this.providerService = options.providerService ?? new ModelProviderService();
    this.settingsStore = options.settingsStore ?? new SettingsStore();
    this.resolveModelImpl = options.resolveModel ?? defaultResolveModel;
    this.onRunEvent = options.onRunEvent;
    this.skillLoader = new SkillLoader(this.workspaceRoot);
    this.sessionManager = new SessionManager(this.workspaceRoot, {
      skillLoader: this.skillLoader,
      ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
      ...(options.globalAgentsPath ? { globalAgentsPath: options.globalAgentsPath } : {}),
    });
    this.runManager = new RunManager({ concurrency: options.concurrency ?? 1 });
    this.isolate = options.isolate ?? false;
    this.workspaces = new WorkspaceManager({
      ...(options.worktreesRoot ? { root: options.worktreesRoot } : {}),
    });
    this.contextWindow = resolveContextWindow({}).window;
  }

  /** 读模型与当前会话；构造后必须 await 一次 */
  async start(): Promise<this> {
    // 先把上次存下来的自定义供应商注册回来，再读默认模型：否则
    // settings 指向自建网关时，这一次 reloadModel 会解析不到供应商
    await this.providerService.loadCustomProviders();
    await this.reloadModel();
    this.subAgentEnabled = await this.settingsStore.getSubagentEnabled();
    if (this.isolate) {
      // 启动时就探测：等用户按下发送才说"隔离不了"，那一刻他已经等了
      const capability = this.workspaces.capability(this.workspaceRoot);
      this.isolationError = capability.supported
        ? null
        : `无法隔离工作区（${capability.reasons.join("；")}）`;
    }
    const latest = this.listSessionInfos();
    // 一段会话都没有就**空着**：会话文件只在第一次发送时创建（见 `send`）。
    // 原来这里会补开一个空会话，于是"点了一下新任务、什么都没说"也会在
    // 磁盘上留下一个文件，侧栏里还多一条"新会话"
    this.currentSessionId = latest[latest.length - 1]?.fileName ?? null;
    return this;
  }

  /** 退出前收尾：跑着的全部取消，挂起的审批作废，隔离工作区全部回收 */
  close(): void {
    this.runManager.cancelAll();
    this.broker.clear();
    // worktree 不回收会在主仓库的 .git/worktrees 里留元数据，磁盘也一直占着
    this.workspaces.dispose();
  }

  // ---------------------------------------------------------------- 状态

  async state(): Promise<AppState> {
    const sessions = this.sessionSummaries();
    const runs = [...this.records.values()]
      .slice(-MAX_RUNS)
      .reverse()
      .map((record) =>
        record.summary(this.contextWindow, this.broker.countFor(record.runId)),
      );
    const label =
      this.providerName && this.modelName
        ? `${this.providerName} / ${this.modelName}`
        : null;
    return {
      workspace: { root: this.workspaceRoot, name: basename(this.workspaceRoot) },
      tier: this.tier,
      model: {
        provider: this.providerName,
        model: this.modelName,
        label,
        contextWindow: this.contextWindow,
        contextWindowSource: this.contextWindowSource,
      },
      approvals: {
        pending: this.broker.list().length,
        oldestRunId: this.broker.oldestRunId(),
      },
      runs,
      sessions,
      currentSessionId: this.currentSessionId,
      sendable: this.model !== null,
      blockReason: this.model
        ? null
        : this.modelError ?? "尚未配置模型：请在设置里选择服务商与模型",
      subAgent: this.subAgentEnabled,
      isolate: this.isolate,
      isolateError: this.isolationError,
    };
  }

  getTier(): Tier {
    return this.tier;
  }

  /** 当前隔离开关（切工作区时要带过去，别让用户的选择悄悄复位） */
  getIsolate(): boolean {
    return this.isolate;
  }

  /**
   * 切档位。
   *
   * **不追溯**：只影响之后的工具调用。已挂起的审批卡仍等人裁决，
   * 既不自动放行也不自动作废——审批是真防线，切档位不该悄悄改写
   * 一次已经发出去的提问。
   */
  setTier(tier: unknown): Tier {
    if (!isTier(tier)) {
      throw new HttpError(400, `无法识别的审批档位：${String(tier)}`);
    }
    this.tier = tier;
    return this.tier;
  }

  // ---------------------------------------------------------------- 模型

  private async reloadModel(): Promise<void> {
    try {
      const resolved = await this.resolveModelImpl(this.providerService, this.settingsStore);
      this.model = resolved.model;
      this.providerName = resolved.providerName;
      this.modelName = resolved.modelName;
      this.modelError = null;
      if (resolved.model) {
        this.sessionManager.setModel(resolved.model);
      }
    } catch (error) {
      this.model = null;
      this.providerName = null;
      this.modelName = null;
      this.modelError = error instanceof Error ? error.message : String(error);
      logger.error("读取模型配置失败:", this.modelError);
    }
    const configured = await this.settingsStore.getContextWindow();
    const resolvedWindow = resolveContextWindow({
      configured,
      modelName: this.modelName,
    });
    this.contextWindow = resolvedWindow.window;
    this.contextWindowSource = resolvedWindow.source;
  }

  async providers(): Promise<ProviderView[]> {
    const parsed = await this.settingsStore.parseDefaultModel();
    const views: ProviderView[] = [];
    for (const name of this.providerService.getRegisteredProviders()) {
      const provider = this.providerService.getProvider(name);
      if (!provider) {
        continue;
      }
      const config = await this.providerService.getProviderConfig(name);
      views.push({
        name,
        sdkType: this.providerService.getProviderSdkType(name),
        baseUrl: config.baseUrl ?? this.providerService.getProviderBaseUrl(name),
        hasApiKey: Boolean(config.apiKey),
        defaultModels: provider.getDefaultModels?.() ?? [],
        selectedModel: parsed?.providerName === name ? parsed.modelName : null,
        custom: this.providerService.isCustomProvider(name),
      });
    }
    return views;
  }

  /** 拉某个供应商的模型列表；失败时退回内置默认列表并带上原因 */
  async models(providerName: string): Promise<{ models: string[]; error: string | null }> {
    const provider = this.providerService.getProvider(providerName);
    if (!provider) {
      throw new HttpError(404, `未知的供应商：${providerName}`);
    }
    const config = await this.providerService.getProviderConfig(providerName);
    const fallback = provider.getDefaultModels?.() ?? [];
    if (!config.apiKey) {
      return { models: fallback, error: "该供应商尚未配置 API Key，只能列出内置默认模型" };
    }
    try {
      const models = await this.providerService.getModelList(
        providerName,
        config.apiKey,
        config.baseUrl,
      );
      return { models: models.length > 0 ? models : fallback, error: null };
    } catch (error) {
      return {
        models: fallback,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 保存模型配置。
   *
   * 三条不可退让的口径：
   * - **密钥只写不读**：请求里没有 `apiKey` 就沿用已保存的那把，
   *   传空串等同"不改"（前端把"已配置"显示成留空即不改）。
   * - **供应商必须已注册**：认不出就报错，不回落到第一个。
   *   唯一的例外是自定义供应商：名字没注册过、但带着 Base URL，
   *   内核会当场建成 OpenAI 兼容槽位（见 saveProviderConfig）。
   * - **上下文窗口清空 = 回到推断**，不是写成 0。
   */
  async configureModel(input: Record<string, unknown>): Promise<void> {
    const providerName = String(input.provider ?? "").trim();
    const modelName = String(input.model ?? "").trim();
    const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
    if (!this.providerService.hasProvider(providerName) && baseUrl.length === 0) {
      throw new HttpError(400, `未知的供应商：${providerName}（新供应商请连同 Base URL 一起给出）`);
    }
    if (modelName.length === 0) {
      throw new HttpError(400, "模型名不能为空");
    }

    const config: { apiKey?: string; baseUrl?: string } = {};
    if (typeof input.apiKey === "string" && input.apiKey.trim().length > 0) {
      config.apiKey = input.apiKey.trim();
    }
    if (typeof input.baseUrl === "string" && input.baseUrl.trim().length > 0) {
      config.baseUrl = input.baseUrl.trim();
    }
    if (Object.keys(config).length > 0) {
      await this.providerService.saveProviderConfig(providerName, config);
    }

    await this.settingsStore.setDefaultModel(`${providerName}/${modelName}`);

    if (input.contextWindow !== undefined) {
      if (input.contextWindow === null) {
        await this.settingsStore.setContextWindow(undefined);
      } else {
        const window = Number(input.contextWindow);
        if (!Number.isFinite(window) || window <= 0) {
          throw new HttpError(400, `上下文窗口必须是正整数，收到：${String(input.contextWindow)}`);
        }
        await this.settingsStore.setContextWindow(Math.floor(window));
      }
    }

    if (input.tier !== undefined) {
      this.setTier(input.tier);
    }

    await this.reloadModel();
  }

  /**
   * 只存供应商凭据，不设默认模型（自定义供应商区的「添加」走这里）。
   *
   * 与 {@link configureModel} 的分工：那边一定挑一个模型当默认，这边
   * 只把"这家网关怎么进"记下来——用户往往得先能看到模型列表才知道
   * 填哪个模型名，一上来就逼他选模型是把顺序颠倒了。
   */
  async configureProvider(input: Record<string, unknown>): Promise<void> {
    const providerName = String(input.provider ?? "").trim();
    if (providerName.length === 0) {
      throw new HttpError(400, "供应商名不能为空");
    }
    const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
    if (!this.providerService.hasProvider(providerName) && baseUrl.length === 0) {
      throw new HttpError(400, "自定义供应商需要 Base URL");
    }

    const config: { apiKey?: string; baseUrl?: string } = {};
    if (typeof input.apiKey === "string" && input.apiKey.trim().length > 0) {
      config.apiKey = input.apiKey.trim();
    }
    if (baseUrl.length > 0) {
      config.baseUrl = baseUrl;
    }
    if (Object.keys(config).length === 0) {
      throw new HttpError(400, "没有可保存的内容");
    }
    await this.providerService.saveProviderConfig(providerName, config);
  }

  /**
   * 删掉一个自定义供应商。
   *
   * 默认模型正指着它时一并清掉：留着会让下次启动去解析一个不存在的
   * 供应商，界面停在"尚未配置模型"却说不出原因。
   */
  async deleteCustomProvider(providerName: string): Promise<void> {
    if (!this.providerService.isCustomProvider(providerName)) {
      throw new HttpError(400, `「${providerName}」不是自定义供应商，不能删除`);
    }
    await this.providerService.deleteCustomProvider(providerName);

    const parsed = await this.settingsStore.parseDefaultModel();
    if (parsed?.providerName === providerName) {
      await this.settingsStore.clearDefaultModel();
      await this.reloadModel();
    }
  }

  /** 委派开关；与 CLI 同义（下一次执行生效，不影响已开跑的那个） */
  setSubAgentEnabled(enabled: unknown): boolean {
    if (typeof enabled !== "boolean") {
      throw new HttpError(400, "subAgent 必须是布尔值");
    }
    this.subAgentEnabled = enabled;
    return this.subAgentEnabled;
  }

  /**
   * 隔离开关。
   *
   * 打开前先探测一次：不支持就**拒绝打开并说明原因**，而不是先开、等发送时
   * 再 409——后者会让人以为开关已经生效。关闭总是允许的：启动时带了
   * `--isolate` 但环境不支持，用户总得有条路退回共用目录。
   */
  setIsolate(enabled: unknown): boolean {
    if (typeof enabled !== "boolean") {
      throw new HttpError(400, "isolate 必须是布尔值");
    }
    if (!enabled) {
      this.isolate = false;
      this.isolationError = null;
      return this.isolate;
    }
    const capability = this.workspaces.capability(this.workspaceRoot);
    if (!capability.supported) {
      this.isolationError = `无法隔离工作区（${capability.reasons.join("；")}）`;
      throw new HttpError(409, this.isolationError);
    }
    this.isolate = true;
    this.isolationError = null;
    return this.isolate;
  }

  // ---------------------------------------------------------------- 会话

  private listSessionInfos(): Array<{ fileName: string; path: string; sizeBytes: number; timestamp: string }> {
    return this.sessionManager.listSessions().map((info) => ({
      fileName: info.fileName,
      path: info.path,
      sizeBytes: info.sizeBytes,
      timestamp: info.timestamp,
    }));
  }

  private sessionSummaries(): SessionSummary[] {
    const infos = this.listSessionInfos();
    const alive = new Set(infos.map((info) => info.fileName));
    for (const key of [...this.metaCache.keys()]) {
      if (!alive.has(key)) {
        this.metaCache.delete(key);
      }
    }
    return infos.map((info) => {
      const cached = this.metaCache.get(info.fileName);
      const base =
        cached && cached.sizeBytes === info.sizeBytes
          ? cached.summary
          : this.buildSessionSummary(info);
      if (!cached || cached.sizeBytes !== info.sizeBytes) {
        this.metaCache.set(info.fileName, { sizeBytes: info.sizeBytes, summary: base });
      }
      return { ...base, isCurrent: info.fileName === this.currentSessionId };
    });
  }

  private buildSessionSummary(info: {
    fileName: string;
    path: string;
    sizeBytes: number;
    timestamp: string;
  }): SessionSummary {
    const meta = readSessionMeta(info.path);
    return {
      sessionId: info.fileName,
      timestamp: info.timestamp,
      title: meta.title || "新会话",
      messageCount: meta.messageCount,
      compactedCount: meta.compactedCount,
      sizeBytes: info.sizeBytes,
      isCurrent: info.fileName === this.currentSessionId,
    };
  }

  listSessions(): SessionSummary[] {
    return this.sessionSummaries();
  }

  createSession(): SessionSummary {
    const store = this.sessionManager.createNewSession();
    const sessionId = basename(store.getFilePath());
    this.currentSessionId = sessionId;
    this.sessions.set(sessionId, { store, messages: store.syncContext([]) });
    return (
      this.sessionSummaries().find((summary) => summary.sessionId === sessionId) ?? {
        sessionId,
        timestamp: sessionId.replace(/\.jsonl$/, ""),
        title: "新会话",
        messageCount: 0,
        compactedCount: 0,
        sizeBytes: 0,
        isCurrent: true,
      }
    );
  }

  /** 历史会话只读回看：切过去只换 view，不动当前会话 */
  readSession(sessionId: string): SessionDetail {
    const context = this.sessionContext(sessionId);
    const summary = this.sessionSummaries().find((item) => item.sessionId === sessionId);
    return {
      sessionId,
      messages: context.messages,
      messageCount: summary?.messageCount ?? context.messages.length,
      compactedCount: summary?.compactedCount ?? 0,
    };
  }

  deleteSession(sessionId: string): { currentSessionId: string | null } {
    const info = this.listSessionInfos().find((item) => item.fileName === sessionId);
    if (!info) {
      throw new HttpError(404, `会话不存在：${sessionId}`);
    }
    // 有 Run 在跑时删掉它正在写的文件，等于让执行落盘失败——先拒绝，别猜
    const active = [...this.records.values()].some(
      (record) =>
        record.sessionId === sessionId &&
        (record.status === "running" || record.status === "blocked" || record.status === "queued"),
    );
    if (active) {
      throw new HttpError(409, "这个会话还有任务在跑，先停止它再删除");
    }
    rmSync(info.path, { force: true });
    this.sessions.delete(sessionId);
    this.metaCache.delete(sessionId);
    this.trustedSessions.delete(sessionId);
    // 删掉的正是当前会话就回到"没有当前会话"：下一段对话从第一次发送算起，
    // 不再顺手补一个空文件（补出来的那条在侧栏里只是一条"新会话"）
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
    return { currentSessionId: this.currentSessionId };
  }

  private sessionContext(sessionId: string): SessionContext {
    const cached = this.sessions.get(sessionId);
    if (cached) {
      return cached;
    }
    const info = this.listSessionInfos().find((item) => item.fileName === sessionId);
    if (!info) {
      throw new HttpError(404, `会话不存在：${sessionId}`);
    }
    const store = new JsonlSessionStore(info.path, this.workspaceRoot);
    if (this.model) {
      store.setModel(this.model);
    }
    const context: SessionContext = { store, messages: store.syncContext([]) };
    this.sessions.set(sessionId, context);
    return context;
  }

  // ---------------------------------------------------------------- Run

  /**
   * 接受一条消息。
   *
   * 立刻返回 runId，执行在后台排队：HTTP 请求不该等一次模型调用。
   * 同一会话内串行（与 CLI 的"忙时排队、回合结束后执行"同口径），
   * 因此"已入队"是真实状态，不只是界面上的一个标签。
   */
  send(prompt: string, sessionId?: string): { runId: string; sessionId: string } {
    const text = prompt.trim();
    if (text.length === 0) {
      throw new HttpError(400, "提问不能为空");
    }
    if (!this.model) {
      throw new HttpError(
        409,
        this.modelError ?? "尚未配置模型：请在设置里选择服务商与模型",
      );
    }
    // 隔离不可用（没装 git / 不在仓库里 / 仓库没有提交）时拒绝发送：
    // "以为隔离了其实共用着"比明说不能并行更危险。开关关掉时不拦：
    // 环境不支持隔离的人总得有条路退回共用目录
    if (this.isolate && this.isolationError) {
      throw new HttpError(409, this.isolationError);
    }
    // 不带 sessionId 就是"开一段新的"：会话在第一次发送时才落盘。
    // 于是"点了新任务但什么都没说"不会留下空文件——那是点击，不是对话
    const targetSession = sessionId ?? this.createSession().sessionId;
    // 会话必须真实存在；顺手把"看起来像路径"的输入挡在门外
    this.sessionContext(targetSession);
    this.currentSessionId = targetSession;

    const runId = newRunId("run");
    const record = new RunRecord({
      runId,
      sessionId: targetSession,
      prompt: text,
      modelLabel: this.modelLabel(),
      now: this.now(),
    });
    this.records.set(runId, record);
    this.push(record, { type: "run_state", status: "queued" });

    const previous = this.chains.get(targetSession) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.execute(record));
    this.chains.set(targetSession, next);
    return { runId, sessionId: targetSession };
  }

  /**
   * 显式丢弃某个 Run 的隔离工作区（界面上的「丢弃」）。
   *
   * worktree 里的改动就是这次执行的产物，因此**不主动回收**：删它必须由
   * 用户发起。任务还在跑时拒绝——那等于把正在执行的工作目录抽掉。
   */
  releaseWorktree(runId: string): void {
    const record = this.record(runId);
    if (record.status === "running" || record.status === "blocked" || record.status === "queued") {
      throw new HttpError(409, "任务还在跑，先停止它再丢弃工作区");
    }
    if (record.workspaceReleased) {
      throw new HttpError(409, "这个任务的隔离工作区已经丢弃过了");
    }
    if (!record.isolated) {
      throw new HttpError(409, "这个任务没有隔离工作区（隔离只对开启后新发的任务生效）");
    }
    const result = this.workspaces.release(runId);
    if (!result.ok) {
      throw new HttpError(409, result.error ?? "回收工作区失败");
    }
    record.workspaceReleased = true;
  }

  /**
   * 这次隔离执行改了什么（运行头的「变更」）。
   *
   * 只给隔离工作区：非隔离时 `git diff` 会混进用户自己的未提交改动。
   * 跑着的时候拒绝——`git add -N` 会写 worktree 的索引，别和执行抢同一个目录。
   */
  runDiff(runId: string): RunDiff {
    const record = this.record(runId);
    if (record.status === "running" || record.status === "blocked" || record.status === "queued") {
      throw new HttpError(409, "任务还在跑，先停止它再看变更");
    }
    if (record.workspaceReleased) {
      throw new HttpError(409, "这个任务的隔离工作区已经丢弃过了");
    }
    if (!record.isolated) {
      throw new HttpError(409, "这个任务没有隔离工作区（隔离只对开启后新发的任务生效）");
    }
    const diff = this.workspaces.diff(runId);
    if (!diff) {
      throw new HttpError(409, "这个任务的隔离工作区已经不在了");
    }
    return { runId, patch: diff.patch, files: diff.files };
  }

  /**
   * 把隔离改动合并回基准工作区。
   *
   * 冲突不自动解决：报错、保留 worktree、列出涉及的文件，由用户处理后再试。
   * 合并成功后**不回收** worktree——删除仍然只能由「丢弃」显式发起。
   */
  mergeWorktree(runId: string): { files: string[] } {
    const record = this.record(runId);
    if (record.status === "running" || record.status === "blocked" || record.status === "queued") {
      throw new HttpError(409, "任务还在跑，先停止它再合并");
    }
    if (record.workspaceReleased) {
      throw new HttpError(409, "这个任务的隔离工作区已经丢弃过了");
    }
    if (!record.isolated) {
      throw new HttpError(409, "这个任务没有隔离工作区（隔离只对开启后新发的任务生效）");
    }
    if (record.workspaceMerged) {
      throw new HttpError(409, "这个任务的改动已经合并过了");
    }
    const result = this.workspaces.merge(runId);
    if (!result.ok) {
      throw new HttpError(409, result.error ?? "合并失败");
    }
    record.workspaceMerged = true;
    return { files: result.files };
  }

  cancel(runId: string): void {
    const record = this.records.get(runId);
    if (!record) {
      throw new HttpError(404, `任务不存在：${runId}`);
    }
    if (record.status === "done" || record.status === "failed" || record.status === "cancelled") {
      return;
    }
    record.cancel();
    if (record.status === "queued") {
      // 还没轮到它：没有 Run 可取消，直接把状态收掉，execute 会看到并跳过
      void this.finish(record, "cancelled");
    }
  }

  /** 单个 Run 的对外摘要（GET /api/runs/:id） */
  runSummary(runId: string): RunSummary {
    const record = this.record(runId);
    return record.summary(this.contextWindow, this.broker.countFor(runId));
  }

  record(runId: string): RunRecord {
    const record = this.records.get(runId);
    if (!record) {
      throw new HttpError(404, `任务不存在：${runId}`);
    }
    return record;
  }

  /**
   * 给这次执行分工地。
   *
   * 隔离开时建一个只属于它的 git worktree；没开隔离时返回基准目录
   * （单任务场景多一层 worktree 只会让用户找不到自己改的文件）。
   * 分配失败时把这次执行收尾成 failed 并返回 null——**不静默退回共用**，
   * 那是 worktree.ts 的第一条硬规则。
   */
  private allocateWorkspace(record: RunRecord): Workspace | null {
    if (!this.isolate) {
      record.workspaceRoot = this.workspaceRoot;
      record.isolated = false;
      return { baseRoot: this.workspaceRoot, root: this.workspaceRoot, isolated: false };
    }
    try {
      const workspace = this.workspaces.allocate(this.workspaceRoot, {
        runId: record.runId,
        isolate: true,
      });
      record.workspaceRoot = workspace.root;
      record.isolated = workspace.isolated;
      return workspace;
    } catch (error) {
      void this.finish(record, "failed", errorMessage(error));
      return null;
    }
  }

  private async execute(record: RunRecord): Promise<void> {
    if (record.status !== "queued") {
      return;
    }
    const model = this.model;
    if (!model) {
      await this.finish(record, "failed", "没有可用模型");
      return;
    }

    const session = this.sessionContext(record.sessionId);
    // 先分工地再置 running：隔离不了要让这次执行带着原因结束，
    // 而不是顶着一个"正在跑"的状态悄悄退回共用目录
    const workspace = this.allocateWorkspace(record);
    if (!workspace) {
      return;
    }
    const runRoot = workspace.root;
    record.status = "running";
    this.push(record, { type: "run_state", status: "running" });

    // 提示里的"当前工作目录"必须是本次执行真正的根：隔离时模型看到的
    // 是 worktree，写成基准目录会让它对着一个自己不写文件的路径推理
    const systemPrompt = this.buildSystemPrompt(runRoot);
    const budget = this.compactionBudget(systemPrompt);

    try {
      // 会话文件是上下文的唯一事实来源：先落盘（含压缩），再把它交给 Run
      await appendUserMessage(
        { store: session.store, messages: session.messages },
        createUserMessage(record.prompt),
        budget,
        record.signal,
      );
    } catch (error) {
      await this.finish(record, "failed", errorMessage(error));
      return;
    }

    const run = this.runManager.create({
      systemPrompt,
      messages: session.messages,
      model,
      tools: (runtime) => this.toolRegistry(runtime, runRoot),
      subAgent: {
        enabled: this.subAgentEnabled,
        trace: false,
        contextBudgetTokens: budget.budget,
        sessionFilePath: session.store.getFilePath(),
      },
      signal: record.signal,
    });
    record.run = run;

    // subscribe 与 hooks.onEvent 是两条通道：这里走前者，因为取消之后
    // 缓冲仍要能回答"最后发生了什么"
    const unsubscribe = run.subscribe((event) => this.observe(record, session, event));

    let synced = 0;
    const result = await this.runManager.start(run, {
      beforeToolCall: this.approvalHook(record, runRoot),
      onTurnEnd: async (turnMessages) => {
        await appendAgentMessages(
          { store: session.store, messages: session.messages },
          turnMessages,
        );
        synced += turnMessages.length;
        try {
          return await compactIfNeeded(
            { store: session.store, messages: session.messages },
            budget,
            run.signal,
          );
        } catch (error) {
          // 压缩失败不该让整次执行失败：历史仍完整，只是这一轮没压
          logger.error("上下文压缩失败:", errorMessage(error));
          return undefined;
        }
      },
    });
    unsubscribe();

    await this.persistRemainder(session, result, synced);
    record.tokens = session.store.estimateContextTokens();
    await this.finish(
      record,
      result.status === "error" ? "failed" : result.status === "cancelled" ? "cancelled" : "done",
      result.error,
    );
  }

  private async persistRemainder(
    session: SessionContext,
    result: RunResult,
    synced: number,
  ): Promise<void> {
    const pending = result.newMessages.slice(synced);
    if (pending.length === 0) {
      return;
    }
    try {
      await appendAgentMessages(
        { store: session.store, messages: session.messages },
        pending,
      );
    } catch (error) {
      logger.error("会话落盘失败，本轮消息未能写入会话文件:", error);
    }
  }

  private observe(record: RunRecord, session: SessionContext, event: AgentEvent): void {
    if (event.type === "turn_end") {
      record.tokens = session.store.estimateContextTokens();
    }
    this.push(record, event);
  }

  private async finish(record: RunRecord, status: RunPhase, error?: string): Promise<void> {
    // 先作废未裁决的审批，并让它们的 continuation 先跑完：
    // 否则前端会先收到 run_done、再收到一张"已失效"的卡，顺序反了会闪一下
    this.broker.cancelRun(record.runId);
    await new Promise<void>((resolve) => setImmediate(resolve));

    record.status = status;
    record.error = error ?? null;
    record.endedAt = this.now();
    this.push(record, {
      type: "run_done",
      status,
      elapsedMs: record.endedAt - record.startedAt,
      tokens: record.tokens,
      ...(error ? { error } : {}),
    });
  }

  private push(record: RunRecord, event: ServerEvent): void {
    // 先给 per-run 流（正文与卡片都靠它），再把控制事件抄一份给应用级日志
    record.push(event);
    if (isRunMetaEvent(event)) {
      this.onRunEvent?.(record.runId, event);
    }
  }

  private modelLabel(): string {
    return this.providerName && this.modelName
      ? `${this.providerName}/${this.modelName}`
      : "未配置模型";
  }

  // ---------------------------------------------------------------- 审批

  resolveApproval(id: string, answer: ApprovalAnswer): { runId: string } {
    const request = this.broker.get(id);
    if (!request) {
      // 重复点击、Run 已结束、Run 已取消都会走到这里——是"失效"而不是"服务出错"
      throw new HttpError(409, "这条审批已失效（可能已裁决，或任务已结束）");
    }
    this.broker.resolve(id, answer);
    return { runId: request.runId };
  }

  listApprovals(): ApprovalRequest[] {
    return this.broker.list();
  }

  /**
   * 审批钩子。
   *
   * 与 CLI 的 `createToolApproval` 同一套语义，只是"问人"的方式换成了
   * 挂起 + HTTP 裁决。三档的界线**不在这个文件里**：裁决表是内核的
   * `core/policy.ts`（M4 的验收就是"三档在两端给出同一裁决"），
   * 这里只负责它管不了的两件事——本会话的"全部允许"，
   * 以及把问题送到浏览器那一头。
   */
  private approvalHook(record: RunRecord, runRoot: string): BeforeToolCall {
    return async (
      call,
      context?: ToolCallContext,
    ): Promise<ToolDecision> => {
      const verdict = evaluateApprovalPolicy(this.tier, call.name, {
        readOnlyTools: READ_ONLY_TOOLS,
      });
      if (verdict.kind === "allow") {
        return { action: "allow", reason: verdict.reason };
      }
      if (verdict.kind === "block") {
        return { action: "block", reason: verdict.reason };
      }
      if (this.trustedSessions.has(record.sessionId)) {
        return { action: "allow", reason: "本会话内已选择全部允许" };
      }

      const request = this.buildApprovalRequest(record, call, context, runRoot);
      record.status = "blocked";
      this.push(record, { type: "approval_request", request });

      const outcome = await this.broker.ask(request, record.signal);
      this.push(record, {
        type: "approval_resolved",
        approvalId: request.id,
        runId: record.runId,
        answer: outcome.answer,
        source: outcome.source,
      });
      if (record.status === "blocked" && this.broker.countFor(record.runId) === 0) {
        record.status = "running";
        this.push(record, { type: "run_state", status: "running" });
      }

      if (outcome.source === "cancelled") {
        return { action: "block", reason: "任务已取消，本次调用未执行" };
      }
      if (outcome.answer === "yes") {
        return { action: "allow", reason: "用户已确认" };
      }
      if (outcome.answer === "always") {
        this.trustedSessions.add(record.sessionId);
        return { action: "allow", reason: "用户已选择本会话不再逐一确认" };
      }
      return { action: "block", reason: "用户未授权该工具调用" };
    };
  }

  private buildApprovalRequest(
    record: RunRecord,
    call: { id: string; name: string; arguments?: Record<string, unknown> },
    context?: ToolCallContext,
    runRoot: string = this.workspaceRoot,
  ): ApprovalRequest {
    // 文件在不在，要按**这次执行**的根问：隔离时 worktree 里的树可能与
    // 基准目录不同（那正是这次执行正在改的东西）
    const fileExists = (relativePath: string): boolean =>
      workspaceFileExists(runRoot, relativePath);
    const toolCall = {
      type: "toolCall" as const,
      id: call.id,
      name: call.name,
      arguments: call.arguments ?? {},
    };
    return {
      id: newApprovalId(),
      runId: record.runId,
      toolCallId: call.id,
      toolName: call.name,
      ...(context
        ? { identity: { agentId: context.agentId, depth: context.depth } }
        : {}),
      risk: assessToolRisk(toolCall, fileExists),
      summary: describeToolCallLines(toolCall, fileExists),
      argsPreview: previewToolArgs(toolCall),
      createdAt: this.now(),
    };
  }

  // ---------------------------------------------------------------- 装配

  private buildSystemPrompt(root: string = this.workspaceRoot): string {
    return buildSystemPrompt({
      workspaceRoot: root,
      fixedContext: this.sessionManager.getFixedContext(),
      skillSummary: this.sessionManager.getSkillSummary(),
      projectStack: formatProjectStack(detectProjectStack(this.workspaceRoot)),
    });
  }

  private compactionBudget(systemPrompt: string): {
    budget: number;
    overhead: number;
    keepRecent: number;
  } {
    this.demoRegistry ??= this.toolRegistry(new SubAgentRuntimeProvider(), this.workspaceRoot);
    return {
      budget: resolveContextBudget(this.contextWindow),
      overhead: contextOverheadTokens(
        systemPrompt,
        this.demoRegistry.definitions(),
      ),
      keepRecent: KEEP_RECENT_MESSAGES,
    };
  }

  /**
   * 按 Run 现造注册表。
   *
   * `task` 工具要从容器里取当次的监督者、模型与取消信号，而容器是每次
   * 执行私有的——共用一份注册表会让并行的两个 Run 互相覆盖（内核的
   * `Run` 正是为此接受工厂而不是固定实例）。
   */
  private toolRegistry(runtime: SubAgentRuntimeProvider, root: string): ToolRegistry {
    const registry = createToolRegistry(root, {
      skillLoader: this.skillLoader,
      extraTools: [
        createSubAgentTool({
          workspaceRoot: root,
          depth: 0,
          runtime: () => runtime.get(),
          parentRegistry: () => registry,
          projectRules: () => this.sessionManager.getFixedContext(),
        }),
      ],
    });
    return registry;
  }

  // ---------------------------------------------------------------- 目录

  /** 目录选择器：只列子目录，不列文件——这里选的是"工作区" */
  listDir(target: string | null): DirListing {
    const path = resolve(target ?? this.workspaceRoot);
    let names: string[];
    try {
      names = readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      throw new HttpError(400, `无法读取目录：${errorMessage(error)}`);
    }
    const entries = names.map((name) => ({ name, path: join(path, name) }));
    const parent = dirname(path);
    return {
      path,
      parent: parent === path ? null : parent,
      entries,
      drives: listDrives(),
    };
  }

  /** 切换工作区前的校验：必须是存在的目录 */
  static assertWorkspaceRoot(candidate: string): string {
    const path = resolve(candidate);
    try {
      if (!statSync(path).isDirectory()) {
        throw new Error("不是目录");
      }
    } catch (error) {
      throw new HttpError(400, `工作区不可用：${errorMessage(error)}`);
    }
    return path;
  }
}

/**
 * Windows 盘符列表。
 *
 * `readdir` 到盘根就到底了（`dirname("D:\\") === "D:\\"`），"上一级"走不出
 * 当前盘，换盘只能枚举。Node 没有列盘符的 API，逐个 `stat` 是最稳的做法：
 * 不起子进程、不依赖已弃用的 `wmic`。非 Windows 返回空数组，前端据此
 * 不画盘符条。
 */
function listDrives(): string[] {
  if (process.platform !== "win32") {
    return [];
  }
  const drives: string[] = [];
  for (let code = 0x41; code <= 0x5a; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (statSync(root).isDirectory()) {
        drives.push(root);
      }
    } catch {
      // 没接入的盘符：跳过
    }
  }
  return drives;
}

/** 默认的模型解析：读 settings + auth.json，构造 SDK 客户端 */
async function defaultResolveModel(
  service: ModelProviderService,
  settings: SettingsStore,
): Promise<ResolvedModel> {
  const parsed = await settings.parseDefaultModel();
  if (!parsed) {
    return { model: null, providerName: null, modelName: null };
  }
  const config = await service.getProviderConfig(parsed.providerName);
  if (!config.apiKey) {
    return { model: null, providerName: null, modelName: null };
  }
  const maxTokens = await settings.getMaxTokens();
  const model = await createModelFromProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: parsed.modelName,
    sdkType: config.sdkType,
    maxTokens,
  });
  return { model, providerName: parsed.providerName, modelName: parsed.modelName };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
