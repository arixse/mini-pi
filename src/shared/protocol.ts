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
};

export type AgentEvent = 
    | {type:"agent_start"}
    | {type:"agent_end",messages:AgentMessage[]}
    | {type:"turn_start";turn:number}
    | {type:"turn_end";turn:number;message:AssistantMessage;toolResults:ToolResultMessage[]}
    | {type:"message_start";message:AgentMessage}
    | {type:"message_update";message:AssistantMessage;delta:string}
    | {type:"message_end";message:AgentMessage}
    | {type:"tool_execution_start";toolCallId:string;toolName:string;args:Record<string,unknown>}
    | {type:"tool_execution_end";toolCallId:string;toolName:string;result:ToolResult;isError:boolean}
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
    | ({type:"subagent_end";ok:boolean;goal:string;role?:string;turns:number;usage:Usage;elapsedMs:number} & AgentIdentity)

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

