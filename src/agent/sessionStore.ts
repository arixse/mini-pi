import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AgentMessage, SessionEntry } from "../shared/protocol";
import { appendFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createTextContent, isTextContent } from "./message";
import { LlmModel } from "./model";

type MessageEntry = Extract<SessionEntry, { type: "message" }>;
type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;

async function summarizeEntries(entries: MessageEntry[], model: LlmModel): Promise<string> {
  if (entries.length === 0) {
    return "";
  }

  // 构建对话历史文本
  const conversationText = entries.map(entry => {
    const role = entry.message.role === "user" ? "用户" : "助手";
    const text = extractText(entry.message);
    return `${role}: ${text}`;
  }).join("\n\n");

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
  } catch (error) {
    console.error("Failed to generate summary with model:", error);
  }

  // 如果模型调用失败，回退到简单摘要
  return generateSimpleSummary(entries);
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

  private loadOrCreate(): void {
    if (!existsSync(this.filePath)) {
      this.writeHeader();
      return;
    }
    const lines = readFileSync(this.filePath, "utf8")
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as SessionEntry;
      this.entries.push(entry);
      if (entry.type !== "session") {
        this.byId.set(entry.id, entry);
        this.leafId = entry.id;
        this.counter = Math.max(
          this.counter,
          Number(entry.id.replace("entry_", "")) || 0,
        );
      }
    }
    if (!this.entries.some((entry) => entry.type === "session")) {
      this.entries.length = 0;
      this.writeHeader();
    }
  }

  private async reset(): Promise<void> {
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

  async compactIfNedded(
    maxApproxTokens: number,
    keepRecentMessages: number,
  ): Promise<CompactionEntry | undefined> {
    const path = this.pathToLeaf();
    const messageEntries = path.filter(
      (entry): entry is MessageEntry => entry.type === "message",
    );
    const currentContext = this.buildContext();
    const tokensBefore = estimateTokens(currentContext);
    if (
      tokensBefore <= maxApproxTokens ||
      messageEntries.length <= keepRecentMessages
    ) {
      return undefined;
    }
    const kept = messageEntries.slice(-keepRecentMessages);
    const summarized = messageEntries.slice(0, -keepRecentMessages);
    
    // 使用模型生成摘要，如果没有模型则使用简单摘要
    let summary: string;
    if (this.model) {
      summary = await summarizeEntries(summarized, this.model);
    } else {
      summary = generateSimpleSummary(summarized);
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
    return entry;
  }
  private pathToLeaf(): SessionEntry[] {
    const path: SessionEntry[] = [];
    let current = this.leafId ? this.byId.get(this.leafId) : null;
    if (current) {
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


function estimateTokens(messages:AgentMessage[]):number {
    return messages.reduce((sum,message)=> {
        const content = extractText(message)
        return sum + Math.ceil(content.length / 2)
    },0)
}

function extractText(message:AgentMessage):string {
    const parts:string[] = []
    for(const block of message.content) {
        if(isTextContent(block)) {
            parts.push(block.text)
        }
    }
    return parts.join("\n")
}