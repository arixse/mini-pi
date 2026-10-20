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
import { logger } from "@minipi/core/shared/logger";
import { ApprovalBroker, newApprovalId } from "./broker";
import { HttpError } from "./errors";
import { previewToolArgs } from "./preview";
import { RunRecord } from "./runs";
import { readSessionMeta } from "./sessionMeta";
import {
  isTier,
  type AppState,
  type ApprovalAnswer,
  type ApprovalRequest,
  type DirListing,
  type ProviderView,
  type RunPhase,
  type RunSummary,
  type ServerEvent,
  type SessionDetail,
  type SessionSummary,
  type Tier,
} from "./types";

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
  private readonly resolveModelImpl: NonNullable<WorkspaceHostOptions["resolveModel"]>;
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
  /** 展示用注册表：只为了拿工具定义算固定开销，不参与执行 */
  private demoRegistry: ToolRegistry | null = null;

  constructor(options: WorkspaceHostOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.tier = options.tier ?? "workspace-write";
    this.now = options.now ?? (() => Date.now());
    this.providerService = options.providerService ?? new ModelProviderService();
    this.settingsStore = options.settingsStore ?? new SettingsStore();
    this.resolveModelImpl = options.resolveModel ?? defaultResolveModel;
    this.skillLoader = new SkillLoader(this.workspaceRoot);
    this.sessionManager = new SessionManager(this.workspaceRoot, {
      skillLoader: this.skillLoader,
      ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
      ...(options.globalAgentsPath ? { globalAgentsPath: options.globalAgentsPath } : {}),
    });
    this.runManager = new RunManager({ concurrency: options.concurrency ?? 1 });
    this.contextWindow = resolveContextWindow({}).window;
  }

  /** 读模型与当前会话；构造后必须 await 一次 */
  async start(): Promise<this> {
    await this.reloadModel();
    const latest = this.listSessionInfos();
    if (latest.length > 0) {
      this.currentSessionId = latest[latest.length - 1]!.fileName;
    } else {
      this.currentSessionId = this.createSession().sessionId;
    }
    return this;
  }

  /** 退出前收尾：跑着的全部取消，挂起的审批作废 */
  close(): void {
    this.runManager.cancelAll();
    this.broker.clear();
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
    };
  }

  getTier(): Tier {
    return this.tier;
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
   * - **上下文窗口清空 = 回到推断**，不是写成 0。
   */
  async configureModel(input: Record<string, unknown>): Promise<void> {
    const providerName = String(input.provider ?? "").trim();
    const modelName = String(input.model ?? "").trim();
    if (!this.providerService.hasProvider(providerName)) {
      throw new HttpError(400, `未知的供应商：${providerName}`);
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

  deleteSession(sessionId: string): { currentSessionId: string } {
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
    // 删掉当前会话时顺手开一个新的：不留"当前会话不存在"的死角
    if (this.currentSessionId === sessionId) {
      this.createSession();
    }
    return { currentSessionId: this.currentSessionId! };
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
    const targetSession = sessionId ?? this.currentSessionId;
    if (!targetSession) {
      throw new HttpError(409, "没有可用的会话");
    }
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
    record.status = "running";
    this.push(record, { type: "run_state", status: "running" });

    const systemPrompt = this.buildSystemPrompt();
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
      tools: (runtime) => this.toolRegistry(runtime),
      subAgent: {
        enabled: true,
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
      beforeToolCall: this.approvalHook(record),
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
    record.push(event);
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
   * 挂起 + HTTP 裁决。三档的界线：
   * - `read-only`：写与执行**直接拒绝**（不是等人点头，是根本不允许）
   * - `workspace-write`：逐次询问，可"本会话内全部允许"（CLI 的默认行为）
   * - `full-access`：全部放行（CLI 的 /trust）
   */
  private approvalHook(record: RunRecord): BeforeToolCall {
    return async (
      call,
      context?: ToolCallContext,
    ): Promise<ToolDecision> => {
      if (READ_ONLY_TOOLS.has(call.name)) {
        return { action: "allow", reason: "只读工具，免确认" };
      }
      if (this.tier === "read-only") {
        return {
          action: "block",
          reason: "当前档位为 read-only：写操作与命令一律不执行（可在设置里切换档位）",
        };
      }
      if (this.tier === "full-access") {
        return { action: "allow", reason: "当前档位为 full-access：不再逐次确认" };
      }
      if (this.trustedSessions.has(record.sessionId)) {
        return { action: "allow", reason: "本会话内已选择全部允许" };
      }

      const request = this.buildApprovalRequest(record, call, context);
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
  ): ApprovalRequest {
    const fileExists = (relativePath: string): boolean =>
      workspaceFileExists(this.workspaceRoot, relativePath);
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

  private buildSystemPrompt(): string {
    return buildSystemPrompt({
      workspaceRoot: this.workspaceRoot,
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
    this.demoRegistry ??= this.toolRegistry(new SubAgentRuntimeProvider());
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
  private toolRegistry(runtime: SubAgentRuntimeProvider): ToolRegistry {
    const registry = createToolRegistry(this.workspaceRoot, {
      skillLoader: this.skillLoader,
      extraTools: [
        createSubAgentTool({
          workspaceRoot: this.workspaceRoot,
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
