export type TextContent = {
    type:"text"
    text:string
}

export type ToolCallContent = {
    type:"toolCall";
    id:string;
    name:string;
    arguments:Record<string,unknown>
}

export type Usage = {
    input:number
    output:number
    totalTokens:number
    /**
     * 命中缓存的输入 token（`input` 的子集）。
     *
     * `input` 的口径统一为"含缓存的输入总量"：OpenAI 系的 `prompt_tokens`
     * 本就包含命中部分；Anthropic 系的 `input_tokens` 不含缓存读写，适配器
     * 会先把它们补回 `input` 再填这里，因此命中率处处都是 `cacheRead / input`。
     *
     * 提供方没返回该字段时保持 `undefined`——"没这个数据"和"命中 0"必须能区分，
     * 否则界面会把"看不到"报成"一次都没命中"。
     */
    cacheRead?:number
    /** 写入缓存的输入 token（`input` 的子集；Anthropic 系 / 显式缓存才会返回） */
    cacheWrite?:number
}

export type UserMessage = {
    role:"user"
    content:TextContent[]
    timestamp:number
}

export type AssistantMessage = {
    role:"assistant"
    content:Array<TextContent | ToolCallContent >
    /**
     * 结束原因：
     * - `stop`：正常结束；
     * - `toolUse`：要调用工具；
     * - `length`：达到输出上限被截断（**不是**用户取消，需要单独提示，
     *   否则用户看到的是"模型调用已取消"，也拿不到"可调大 maxTokens"的提示）；
     * - `error`：调用失败；
     * - `aborted`：用户取消。
     */
    stopReason:"stop" | "toolUse" | "error" | "aborted" | "length"
    usage:Usage
    timestamp:number
    errorMessage?:string
}

export type ToolResultMessage = {
    role:"toolResult"
    toolCallId:string
    toolName:string
    content:TextContent[]
    details?:unknown
    isError:boolean
    timestamp:number
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage

export type ToolDefinition = {
    name:string
    description:string
    parameters:Record<string,unknown >
}

export type ToolResult = {
    content:TextContent[]
    details?:unknown
    /**
     * 工具把这次调用判定为失败（例如命令非零退出或超时）。
     *
     * 工具**自己返回**失败结果（而不是抛错）时，仍需要保留 stdout/stderr/details，
     * 所以失败状态必须显式带出来，不能只靠"有没有抛异常"判断。
     */
    isError?:boolean
    terminate?:boolean
}

export type SessionEntry = 
    | {type:"session";version:1;id:string;cwd:string;timestamp:string}
    | {type:"message";id:string;parentId:string|null;timestamp:string;message:AgentMessage}
    | {type:"compaction";
        id:string;
        parentId:string|null;
        timestamp:string;
        summary:string;
        firstKeptEntryId:string;
        tokensBefore:number
    }

/**
 * Agent 在委派树里的身份。
 *
 * 主 Agent 的 `parentId` 为 `null`、`depth` 为 0；每委派一层 depth 加 1。
 * `agentId` 用于把 CLI 上的事件与具体的工具调用对起来——嵌套之后
 * "这条 bash 是谁要跑的"必须能回答，否则审批提示就是一笔糊涂账。
 */
export type AgentIdentity = {
  agentId: string;
  parentId: string | null;
  depth: number;
};

/** 一次委派的结果（子 Agent 回交给父 Agent 的全部内容） */
export type SubAgentResult = {
  /** 是否完整完成了目标；到轮次上限或出错时为 false（此时 summary 是"做到哪一步"） */
  ok: boolean;
  /** 给父 Agent 看的结论，已按上限裁剪并显式标注 */
  summary: string;
  /** 子 Agent 各轮用量之和 */
  usage: Usage;
  /** 实际跑过的轮次数 */
  turns: number;
  /** 是否被用户取消 */
  aborted: boolean;
  /** summary 是否被截断 */
  truncated: boolean;
  /** ok 为 false 时的原因，例如 `max_turns_exceeded` */
  error?: string;
  /**
   * 是否因**整体墙钟超时**被掐断。
   *
   * 必须与「用户取消」（`aborted`）分开：前者是系统按超时护栏主动收尾，
   * 收尾时会带上已经得到的阶段性结论；后者是用户主动中断，整棵树立刻停。
   * 两者都表现为「没做完」，但该给模型的建议完全相反。
   */
  timedOut?: boolean;
  /**
   * 子 Agent 实际调用过的工具名，**按调用顺序、含重复**。
   *
   * 存在的唯一理由是"委派到底干了什么"在结果层此前不可见：委派对父会话
   * 只是一条 toolCall/toolResult，卡片只有轮次与 token 数——于是
   * "review 说 FAIL 但它真的跑过验证吗"这个问题在委派结束后无法回答，
   * 只能去翻 trace。它是观测字段，**不进模型可见的 summary**
   * （每次委派都往上下文里塞一串工具名是纯成本）。
   */
  toolCalls?: string[];
};

export type AgentEvent = 
    | {type:"agent_start"}
    | {type:"agent_end",messages:AgentMessage[]}
    | {type:"turn_start";turn:number}
    | {type:"turn_end";turn:number;message:AssistantMessage;toolResults:ToolResultMessage[]}
    | {type:"message_start";message:AgentMessage}
    | {type:"message_update";message:AssistantMessage;delta:string}
    | {type:"message_end";message:AgentMessage}
    | {
        type: "tool_execution_start";
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        /**
         * 这次调用来自哪一层 Agent；主 Agent 不携带。
         *
         * 没有它时子 Agent 的 `read_file` 卡片与父级的长得完全一样，
         * 终端上分不清是谁在读文件（`/last` 同理）。
         */
        identity?: AgentIdentity;
      }
    | {
        type: "tool_execution_end";
        toolCallId: string;
        toolName: string;
        result: ToolResult;
        isError: boolean;
        identity?: AgentIdentity;
      }
    | {type:"tool_permission";toolCallId:string;toolName:string;action:string;reason?:string;originalArgs:ToolCallContent["arguments"];args:ToolCallContent["arguments"]}
    | {type:"compaction";summary:string;tokensBefore:number;firstKeptEntryId:string}
    | {type:"branch_switch";leafId:string}
    /**
     * 子 Agent 生命周期。
     *
     * 这两个事件只对**委派**发出，用于 CLI 渲染嵌套结构；子 Agent 内部的
     * 工具卡片等仍用既有事件，由 `AgentIdentity` 区分来自哪一层。
     * 追加在联合类型末尾，不改动已有成员，既有的 switch 不会漏分支。
     */
    | ({type:"subagent_start";goal:string;role?:string} & AgentIdentity)
    | ({type:"subagent_end";ok:boolean;goal:string;role?:string;turns:number;usage:Usage;elapsedMs:number;toolCalls?:string[]} & AgentIdentity)

export type SessionResponse = {
    sessionId:string
    leafId:string | null
    messages:AgentMessage[]
    events:AgentEvent[]
    tools:ToolDefinition[]
    entries:SessionEntry
}

export type RunStreamEvent = 
    | AgentEvent 
    | {type:"run_done";session:SessionResponse}
    | {type:"run_error";error:string;session:SessionResponse}

export type CreateRunResponse = {runId:string}

