import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AgentMessage, SessionEntry } from "../shared/protocol";
import { appendFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createTextContent, isTextContent } from "./message";
import { LlmModel } from "./model";
import { logger } from "../shared/logger";

type MessageEntry = Extract<SessionEntry, { type: "message" }>;
type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;

/** 摘要输入的最小 token 预算：阈值配得很小时也不要把输入砍成空 */
export const MIN_SUMMARY_INPUT_TOKENS = 4_000;

/**
 * 让模型把一段历史压成摘要。
 *
 * @param signal 取消信号：压缩要调一次模型，可能静默数秒，必须能被 Ctrl+C 中断
 *   （否则"已请求取消"之后还要空等一整次请求，README 承诺的"立即中断"就不成立）。
 * @param maxInputTokens 摘要输入的 token 预算。压缩的触发点就是"上下文超了"，
 *   把整段历史原样塞进摘要请求会让它自己超窗（400），而超窗正是这里最常见的失败。
 *   因此按预算只保留**最近**的条目，更早的明确标注被省略。
 *
 * 被取消**或失败**时都抛出而不是回退到简单摘要：简单摘要只有"共 N 条消息"这类统计，
 * 写进会话文件等于把真实历史换成一句废话，且已经落盘、不可恢复。
 */
async function summarizeEntries(
  entries: MessageEntry[],
  model: LlmModel,
  signal?: AbortSignal,
  maxInputTokens?: number,
): Promise<string> {
  if (entries.length === 0) {
    return "";
  }

  const budget = Math.max(
    MIN_SUMMARY_INPUT_TOKENS,
    normalizeTokenBudget(maxInputTokens),
  );
  const { text: conversationText } = buildSummarizableText(entries, budget);

  // 使用模型生成摘要
  const systemPrompt = `你是一个对话摘要助手。请将以下对话历史压缩成一个简洁的摘要，保留关键信息和上下文。

要求：
1. 保留用户的主要请求和意图
2. 保留助手的关键回复和解决方案
3. 保留重要的工具调用和结果
4. 使用简洁的中文描述
5. 保留用户任务的关键执行进度
6. 摘要长度控制在200字以内`;

  const messages: AgentMessage[] = [
    {
      role: "user",
      content: [createTextContent(`请为以下对话生成摘要：\n\n${conversationText}`)],
      timestamp: Date.now(),
    }
  ];

  try {
    const response = await model.complete({
      systemPrompt,
      messages,
      tools: [],
      signal,
    });

    // 提取模型回复的文本
    const summaryParts: string[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        summaryParts.push(block.text);
      }
    }

    if (summaryParts.length > 0) {
      return summaryParts.join("\n");
    }

    // 空回复与失败同等对待：回退到简单摘要会把真实历史换成统计数字
    throw new Error("摘要模型返回了空内容");
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    logger.error("Failed to generate summary with model:", error);
    throw error;
  }
}

/**
 * 组装摘要输入：从**最近**的条目往前累积，超出预算就停。
 *
 * 压缩只在这段历史已经很大时才触发，所以"整段塞进去"几乎必然让摘要请求自己超窗；
 * 一旦超窗，摘要失败 → 压缩不写入 → 上下文继续涨，下一次仍然超窗，形成死锁。
 * 这里主动按预算保留最近的条目，并在开头标注被省略的条数，
 * 让模型知道它看到的是一段被截断的历史。
 */
function normalizeTokenBudget(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : MIN_SUMMARY_INPUT_TOKENS;
}

/**
 * 组装摘要输入：从**最近**的条目往前累积，超出预算就停。
 *
 * 压缩只在这段历史已经很大时才触发，所以"整段塞进去"几乎必然让摘要请求自己超窗；
 * 一旦超窗，摘要失败 → 压缩不写入 → 上下文继续涨，下一次仍然超窗，形成死锁。
 * 这里主动按预算保留最近的条目，并在开头标注被省略的条数，
 * 让模型知道它看到的是一段被截断的历史。
 *
 * 预算下限（{@link MIN_SUMMARY_INPUT_TOKENS}）由调用方施加：
 * 本函数按传入的预算严格执行，便于直接断言截断行为。
 */
export function buildSummarizableText(
  entries: MessageEntry[],
  maxInputTokens: number,
): { text: string; dropped: number } {
  const budget =
    Number.isFinite(maxInputTokens) && maxInputTokens > 0
      ? Math.floor(maxInputTokens)
      : 0;

  const parts: string[] = [];
  let used = 0;
  let dropped = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const role = entry.message.role === "user" ? "用户" : "助手";
    const line = `${role}: ${extractText(entry.message)}`;
    const cost = estimateTextTokens(line);

    // 至少保留一条：单条就超预算时也要让它进去，否则摘要输入会是空串
    if (parts.length > 0 && used + cost > budget) {
      dropped = index + 1;
      break;
    }

    parts.unshift(line);
    used += cost;
  }

  const body = parts.join("\n\n");
  return {
    text: dropped > 0 ? `（最早的 ${dropped} 条消息已省略）\n\n${body}` : body,
    dropped,
  };
}

function generateSimpleSummary(entries: MessageEntry[]): string {
  const parts: string[] = [];
  
  // 统计消息数量
  const userMessages = entries.filter(e => e.message.role === "user");
  const assistantMessages = entries.filter(e => e.message.role === "assistant");
  const toolResultMessages = entries.filter(e => e.message.role === "toolResult");
  
  parts.push(`对话共 ${entries.length} 条消息`);
  
  if (userMessages.length > 0) {
    parts.push(`用户消息 ${userMessages.length} 条`);
  }
  if (assistantMessages.length > 0) {
    parts.push(`助手回复 ${assistantMessages.length} 条`);
  }
  if (toolResultMessages.length > 0) {
    parts.push(`工具调用 ${toolResultMessages.length} 次`);
  }

  // 提取用户的前几个主要请求
  const userRequests: string[] = [];
  for (const entry of userMessages.slice(0, 3)) {
    const text = extractText(entry.message);
    if (text.trim()) {
      const truncated = text.length > 100 ? text.substring(0, 100) + "..." : text;
      userRequests.push(truncated);
    }
  }
  
  if (userRequests.length > 0) {
    parts.push("用户主要请求：");
    for (const request of userRequests) {
      parts.push(`- ${request}`);
    }
  }

  // 提取工具调用信息
  const toolCalls: string[] = [];
  for (const entry of assistantMessages) {
    for (const block of entry.message.content) {
      if (block.type === "toolCall") {
        toolCalls.push(block.name);
      }
    }
  }
  
  if (toolCalls.length > 0) {
    const uniqueTools = [...new Set(toolCalls)];
    parts.push(`使用工具：${uniqueTools.join("、")}`);
  }

  return parts.join("\n");
}

export class JsonlSessionStore {
  private readonly sessionId = "mini-pi-session";
  private readonly entries: SessionEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private leafId: string | null = null;
  private counter = 0;
  private model: LlmModel | null = null;
  private readonly loadWarnings: Array<{ line: number; reason: string }> = [];
  /** 最近一次压缩失败的原因（成功后清空）；供 /status 展示 */
  private lastCompactionError: string | null = null;
  
  constructor(
    private readonly filePath: string,
    private readonly cwd: string,
  ) {
    this.loadOrCreate();
  }

  setModel(model: LlmModel): void {
    this.model = model;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  switchLeafId(leafId: string): void {
    if (!this.byId.has(leafId)) {
      throw new Error(`Unkownn session entry:${leafId}`);
    }
    this.leafId = leafId;
  }

  /**
   * 加载会话文件。
   *
   * 逐行解析，**单行损坏只跳过该行并记下警告**，不再让整份会话打不开
   * （进程被强杀在写一半、磁盘错误等都可能留下半行 JSON）。
   *
   * "损坏"包括**结构不合法**（未知 type、缺必填字段）：这类行也是合法 JSON，
   * 只校验 `type` 是字符串就放行，会在后面访问 `entry.id` 时抛 TypeError，
   * 而构造函数抛错等于 CLI 直接起不来。
   */
  private loadOrCreate(): void {
    if (!existsSync(this.filePath)) {
      this.writeHeader();
      return;
    }
    const lines = readFileSync(this.filePath, "utf8")
      .split("\n")
      .filter(Boolean);

    lines.forEach((line, index) => {
      const entry = this.parseEntry(line, index + 1);
      if (!entry) {
        return;
      }
      this.entries.push(entry);
      if (entry.type !== "session") {
        this.byId.set(entry.id, entry);
        this.leafId = entry.id;
        this.counter = Math.max(
          this.counter,
          Number(entry.id.replace("entry_", "")) || 0,
        );
      }
    });

    if (!this.entries.some((entry) => entry.type === "session")) {
      this.entries.length = 0;
      this.writeHeader();
    }
  }

  /** 解析单行；JSON 非法或结构不合法时记录警告并返回 null */
  private parseEntry(line: string, lineNumber: number): SessionEntry | null {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.loadWarnings.push({
        line: lineNumber,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    const result = validateSessionEntry(value);
    if ("reason" in result) {
      this.loadWarnings.push({ line: lineNumber, reason: result.reason });
      return null;
    }
    return result.entry;
  }

  /** 加载时被跳过的损坏行（行号从 1 起） */
  getLoadWarnings(): Array<{ line: number; reason: string }> {
    return [...this.loadWarnings];
  }

  /**
   * 最近一次压缩失败的原因；没有失败过则为 null。
   *
   * 压缩失败是静默的：不写条目、上下文继续涨，用户只看到"一直没压缩"。
   * 暴露出来才能在 /status 里说明"为什么没压"。
   */
  getLastCompactionError(): string | null {
    return this.lastCompactionError;
  }

  /** 会话文件路径（/status 展示用） */
  getFilePath(): string {
    return this.filePath;
  }

  /** 当前上下文消息条数（不含压缩摘要合成的那条） */
  messageCount(): number {
    return this.buildContext().length;
  }

  /** 当前上下文的近似 token 数（与压缩判定同一套估算） */
  estimateContextTokens(): number {
    return estimateTokens(this.buildContext());
  }

  /**
   * 清空当前会话：重置内存状态并重写会话文件（只保留新的会话头）。
   */
  async reset(): Promise<void> {
    if (existsSync(this.filePath)) {
      await rm(this.filePath);
    }
    this.entries.length = 0;
    this.byId = new Map();
    this.leafId = null;
    this.counter = 0;
    this.writeHeader();
  }

  private writeHeader(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const header: SessionEntry = {
      type: "session",
      version: 1,
      id: this.sessionId,
      timestamp: new Date().toISOString(),
      cwd: this.cwd,
    };
    this.entries.push(header);
    writeFileSync(this.filePath, `${JSON.stringify(header)}\n`, "utf8");
  }
  private nextId(): string {
    this.counter += 1;
    return `entry_${this.counter}`;
  }

  async appendMessage(message: AgentMessage): Promise<string> {
    const id = this.nextId();
    const entry: MessageEntry = {
      type: "message",
      id,
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message,
    };
    await this.appendEntry(entry);
    this.leafId = id;
    return id;
  }

  async appendEntry(entry: SessionEntry): Promise<void> {
    this.entries.push(entry);
    if (entry.type !== "session") {
      this.byId.set(entry.id, entry);
    }
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  /**
   * 是否满足压缩条件。
   *
   * UI 需要在真正压缩前给出"压缩中"提示（压缩要调模型，可能静默数秒），
   * 因此把判定单独暴露出来，与 compactIfNedded 共用同一份逻辑，避免两处条件分叉。
   *
   * @param overheadTokens 不随消息增长、但每次请求都会带上的固定开销
   *   （系统提示与工具定义）。不传则只按消息历史估算——那会低估真实请求大小，
   *   因为 AGENTS.md 固定上下文与 Skill 摘要都挂在系统提示里。
   */
  needsCompaction(
    maxApproxTokens: number,
    keepRecentMessages: number,
    overheadTokens = 0,
  ): boolean {
    const keepRecent = Math.max(1, Math.floor(keepRecentMessages) || 1);
    const messageEntries = this.pathToLeaf().filter(
      (entry): entry is MessageEntry => entry.type === "message",
    );
    if (messageEntries.length <= keepRecent) {
      return false;
    }
    return (
      estimateTokens(this.buildContext()) + normalizeOverheadTokens(overheadTokens) >
      maxApproxTokens
    );
  }

  /**
   * 上下文超限时把较早的消息压缩成一条摘要记录。
   *
   * @param maxApproxTokens 近似 token 上限，未超过则不做任何事
   * @param keepRecentMessages 压缩后保留的最近消息条数，最小为 1
   *   （`slice(-0)` 等价于 `slice(0)`，即"全部保留"，因此 0 会被规范化为 1）
   * @param overheadTokens 固定开销（系统提示 + 工具定义），见 {@link needsCompaction}
   * @param signal 取消信号：压缩要调一次模型，必须能被 Ctrl+C 中断
   */
  async compactIfNedded(
    maxApproxTokens: number,
    keepRecentMessages: number,
    overheadTokens = 0,
    signal?: AbortSignal,
  ): Promise<CompactionEntry | undefined> {
    if (signal?.aborted) {
      // 已取消就不要白调一次摘要模型
      return undefined;
    }
    if (!this.needsCompaction(maxApproxTokens, keepRecentMessages, overheadTokens)) {
      return undefined;
    }

    const overhead = normalizeOverheadTokens(overheadTokens);
    const keepRecent = Math.max(1, Math.floor(keepRecentMessages) || 1);
    const path = this.pathToLeaf();
    const messageEntries = path.filter(
      (entry): entry is MessageEntry => entry.type === "message",
    );
    // 窗口起点必须落在不与 toolResult 断链的位置：被摘要吞掉的
    // assistant toolCall 会让留下的 toolResult 变成孤儿，协议层直接 400。
    const startIndex = alignCompactionStart(
      messageEntries.map((entry) => entry.message.role),
      keepRecent,
    );
    if (startIndex <= 0) {
      // 整段历史都要保留才能维持消息配对：此时压缩只会把上下文清空，
      // 宁可不压（压缩是优化，不能反过来破坏可用的上下文）。
      return undefined;
    }

    // 压缩前真实的请求规模：消息历史 + 固定开销
    const tokensBefore = estimateTokens(this.buildContext()) + overhead;
    const kept = messageEntries.slice(startIndex);
    const summarized = messageEntries.slice(0, startIndex);

    // 优先用模型生成摘要；未配置模型时才用简单摘要兜底（不能因为没有模型就压不了）。
    // 配了模型却调用失败，则**放弃本次压缩**：写一条降级摘要等于把真实历史换成统计数字。
    let summary: string;
    try {
      summary = this.model
        ? await summarizeEntries(summarized, this.model, signal, maxApproxTokens)
        : generateSimpleSummary(summarized);
    } catch (error) {
      // 取消与失败都走这里：保持原上下文、不写任何条目。
      // 记下原因供 /status 展示——否则用户只会看到"一直没有压缩"，无从判断。
      this.lastCompactionError =
        error instanceof Error ? error.message : String(error);
      return undefined;
    }

    // 摘要期间被取消：同样不要写入
    if (signal?.aborted) {
      return undefined;
    }

    const firstKeptEntryId = kept[0]?.id;
    if (!firstKeptEntryId) {
      return undefined;
    }
    const entry: CompactionEntry = {
      type: "compaction",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
    };
    await this.appendEntry(entry);
    this.leafId = entry.id;
    this.lastCompactionError = null;
    return entry;
  }
  /**
   * 从 leaf 沿 parentId 回溯到根，返回 root -> leaf 顺序的完整链路。
   *
   * 必须是循环：只回溯一层会让 buildContext() 永远只返回最后一条消息，
   * 历史上下文和压缩定位（firstKeptEntryId）全部失效。
   */
  private pathToLeaf(): SessionEntry[] {
    const path: SessionEntry[] = [];
    let current: SessionEntry | undefined = this.leafId
      ? this.byId.get(this.leafId)
      : undefined;
    while (current) {
      path.unshift(current);
      current =
        "parentId" in current && current.parentId
          ? this.byId.get(current.parentId)
          : undefined;
    }
    return path;
  }

  buildContext(): AgentMessage[] {
    const path = this.pathToLeaf();
    const latestCompactionIndex = findLastIndex(
      path,
      (entry) => entry.type === "compaction",
    );
    if (latestCompactionIndex === -1) {
      return path.flatMap(entryToMessage);
    }
    const compaction = path[latestCompactionIndex] as CompactionEntry;
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          createTextContent(
            `以下是旧的上下文摘要。后续回答必须参考它，但最近的消息优先级更高。\n\n ${
              compaction.summary
            }`,
          ),
        ],
        timestamp:new Date(compaction.timestamp).getTime()
      },
    ];
    let foundFirstKept = false
    for(let i=0;i<latestCompactionIndex;i++) {
        const entry = path[i]
        if(entry.id===compaction.firstKeptEntryId) {
            foundFirstKept = true
        }
        if(foundFirstKept) {
            messages.push(...entryToMessage(path[i]))
        }
    }
    for(let i=latestCompactionIndex+1;i<path.length;i++) {
        messages.push(...entryToMessage(path[i]))
    }
    return messages
  } 

  /**
   * 用当前会话上下文（含压缩摘要）覆盖 target 数组的内容。
   *
   * 保持数组引用不变，供 REPL 这类长期持有 messages 引用的调用方使用，
   * 使会话文件成为上下文的唯一事实来源，压缩结果因此真正生效。
   */
  syncContext(target: AgentMessage[]): AgentMessage[] {
    const context = this.buildContext();
    target.length = 0;
    target.push(...context);
    return target;
  }

}

function entryToMessage(entry:SessionEntry):AgentMessage[] {
    if(entry.type!=="message") {
        return []
    }
    return [entry.message]
}

function findLastIndex<T>(items:T[],predicate:(item:T)=>boolean):number {
    for(let i=items.length-1;i>=0;i--) {
        if(predicate(items[i])) {
            return i
        }
    }
    return -1
}

/** 单行会话条目的结构校验结果 */
export type SessionEntryValidation = { entry: SessionEntry } | { reason: string };

/** 固定开销规范化：非法值（NaN / 负数 / 非有限）按 0 处理，避免把阈值算歪 */
function normalizeOverheadTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidRole(value: unknown): boolean {
  return value === "user" || value === "assistant" || value === "toolResult";
}

/** `parentId` 允许为 null（链首），否则必须是非空字符串 */
function isValidParentId(value: unknown): boolean {
  return value === null || isNonEmptyString(value);
}

/**
 * 校验一行会话数据的结构。
 *
 * 只校验**代码真正依赖**的字段，但它们缺一不可：
 * - `id` 缺失时 `loadOrCreate` 里的 `entry.id.replace(...)` 直接抛 TypeError，
 *   而它在构造函数里被调用——等于整个 CLI 起不来；
 * - `parentId` 缺失时链会悄悄断掉（`"parentId" in current` 为假），历史静默丢失。
 *
 * 这类行是**合法 JSON**，所以 JSON.parse 的 try/catch 兜不住；必须单独校验。
 * 校验失败的行由调用方记警告后跳过，与"单行损坏只跳过该行"的契约保持一致。
 */
export function validateSessionEntry(value: unknown): SessionEntryValidation {
  if (!isRecord(value)) {
    return { reason: "不是 JSON 对象" };
  }

  const type = value.type;
  if (typeof type !== "string") {
    return { reason: "缺少 type 字段" };
  }

  switch (type) {
    case "session": {
      if (typeof value.version !== "number") {
        return { reason: "session 缺少 version 字段" };
      }
      if (!isNonEmptyString(value.id)) {
        return { reason: "session 缺少 id 字段" };
      }
      return { entry: value as unknown as SessionEntry };
    }

    case "message": {
      if (!isNonEmptyString(value.id)) {
        return { reason: "message 缺少 id 字段" };
      }
      if (!("parentId" in value) || !isValidParentId(value.parentId)) {
        return { reason: "message 的 parentId 非法" };
      }
      if (!isRecord(value.message)) {
        return { reason: "message 缺少 message 字段" };
      }
      if (!isValidRole(value.message.role)) {
        return { reason: `message.role 非法：${String(value.message.role)}` };
      }
      return { entry: value as unknown as SessionEntry };
    }

    case "compaction": {
      if (!isNonEmptyString(value.id)) {
        return { reason: "compaction 缺少 id 字段" };
      }
      if (!("parentId" in value) || !isValidParentId(value.parentId)) {
        return { reason: "compaction 的 parentId 非法" };
      }
      if (typeof value.summary !== "string") {
        return { reason: "compaction 缺少 summary 字段" };
      }
      if (!isNonEmptyString(value.firstKeptEntryId)) {
        return { reason: "compaction 缺少 firstKeptEntryId 字段" };
      }
      return { entry: value as unknown as SessionEntry };
    }

    default:
      return { reason: `未知的条目类型：${type}` };
  }
}

/**
 * 计算压缩窗口的起点（在消息序列中的下标）。
 *
 * 压缩会把"窗口之前"的消息换成一条摘要，因此窗口的**第一条**消息不能是
 * `toolResult`：它对应的 assistant `toolCall` 会被摘要吞掉，还原上下文时
 * 就成了一条引用不存在 tool_call_id 的孤儿 toolResult，OpenAI 会直接 400，
 * 而这条非法序列已经落盘——之后每轮都从会话文件重建出同样的非法上下文，
 * 该会话再也发不出请求。
 *
 * 因此起点要向前回退到第一个非 toolResult 的消息（即拥有这批结果的
 * assistant 消息），保证 `assistant(toolCalls) + 它的全部 toolResult`
 * 同进同出。一条 assistant 可能带多个工具调用，所以必须循环回退。
 *
 * @returns 窗口起点下标；为 0 表示整段历史都要保留（调用方应放弃本次压缩）
 */
export function alignCompactionStart(
  roles: ReadonlyArray<AgentMessage["role"]>,
  keepRecentMessages: number,
): number {
  const keepRecent = Math.max(1, Math.floor(keepRecentMessages) || 1);
  let start = Math.max(0, roles.length - keepRecent);
  while (start > 0 && roles[start] === "toolResult") {
    start -= 1;
  }
  return start;
}


/**
 * 估算一条文本的 token 数。
 *
 * 此前的 `length / 2` 对中英混排偏差很大：英文按字符数约 4:1 才接近真实 token，
 * 于是英文内容被高估约一倍、中文反而略被低估（P2 #17）。
 * 这里按字符类别分别计价：
 * - ASCII（字母/数字/标点，含换行）：约 4 字符 1 token；
 * - CJK 汉字与全角标点：约 1 字符 1 token（略偏保守，早压缩比超窗安全）；
 * - 其余（emoji、其它文种）：约 1 字符 1 token。
 *
 * 仍然是估算：只用于"是否压缩"的阈值判断，不参与计费或协议字段。
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let wide = 0;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      ascii += 1;
    } else {
      wide += 1;
    }
  }

  return Math.ceil(ascii / 4 + wide);
}

/**
 * 估算一条消息的 token 数。
 *
 * 除了 text block，还必须计入 **toolCall 的参数**：参数不写在 text 里，
 * 但会原样发给模型（`write_file` 的 `content`、`edit_file` 的 `newText`
 * 都可能上万字符）。漏算的后果不是"略有偏差"而是"恒为 0"——实测一条带
 * 20 万字符参数的消息估算为 0 token，于是上下文早就爆了、压缩却永不触发，
 * 直接把请求撑到 400。
 *
 * `toolResult` 的 `details` 不发给模型（只有 `content` 的正文会发），因此不计。
 */
export function estimateMessageTokens(message: AgentMessage): number {
  let tokens = estimateTextTokens(extractText(message));

  if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "toolCall") {
        tokens += estimateTextTokens(block.name);
        // JSON.stringify 会带上引号与括号，属于轻微高估（偏保守，安全方向）
        tokens += estimateTextTokens(JSON.stringify(block.arguments ?? {}));
      }
    }
  }

  return tokens;
}

/** 估算整个上下文的 token 数 */
export function estimateTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/**
 * 取一条消息里的**正文文本**，供生成摘要使用。
 *
 * 刻意不含 toolCall 的参数：摘要请求会把返回值拼进一条 user 消息，
 * 若把上万字符的工具参数也算进去，摘要请求自己就会超窗。
 * 估算 token 请用 {@link estimateMessageTokens}，它另外计入参数。
 */
function extractText(message:AgentMessage):string {
    const parts:string[] = []
    for(const block of message.content) {
        if(isTextContent(block)) {
            parts.push(block.text)
        }
    }
    return parts.join("\n")
}