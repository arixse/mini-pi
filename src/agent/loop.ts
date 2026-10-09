import { AgentEvent, AgentIdentity, AgentMessage, AssistantMessage, ToolCallContent, ToolDefinition, ToolResultMessage } from "../shared/protocol";
import { createTextContent } from "./message";
import { LlmModel } from "./model";
import { ToolRegistry } from "./tools";


export type ToolDecision = 
    | {action:"allow";reason?:string}
    | {action:"block";reason?:string}
    | {action:"rewrite",args:Record<string,unknown>;reason?:string}
/**
 * 工具调用来自哪一层 Agent。
 *
 * 主 Agent 的调用不携带身份（保持既有行为），子 Agent 的调用会带上 depth，
 * 于是审批提示能写出「[子 Agent depth=1] 写入 xxx」——
 * 没有它，用户在终端看到一次写文件时无法判断是自己的 Agent 还是它派出去的那个，
 * 而"要不要放行"这件事在两种情形下完全不同。
 */
export type ToolCallContext = AgentIdentity;

export type BeforeToolCall = (
  call: ToolCallContent,
  context?: ToolCallContext,
) => Promise<ToolDecision>;

export type RunAgentLoopOptions = {
    systemPrompt:string
    messages:AgentMessage[]
    tools:ToolDefinition[]
    model:LlmModel
    toolRegistry:ToolRegistry
    /** 最大循环轮次，默认值为 100 */
    maxTurns?:number
    beforeToolCall?:BeforeToolCall
    /**
     * 本次循环属于哪个 Agent。子 Agent 循环传入自己的身份，
     * 这样 `beforeToolCall` 收到的 context 能区分调用来自哪一层。
     */
    identity?:AgentIdentity
    /** 外部取消信号（例如 Ctrl+C）：中止模型请求与正在执行的工具 */
    signal?:AbortSignal
    /**
     * 每轮结束（含工具结果）后回调，用于落盘与检查上下文压缩。
     *
     * 参数是本轮新增的消息；返回新的上下文表示已压缩，
     * 循环会用返回值替换内部上下文（不返回则保持不变）。
     * 单轮内可以跑很多次工具调用，只有每轮都给一次机会才兜得住上下文增长。
     */
    onTurnEnd?:(turnMessages:AgentMessage[])=>Promise<AgentMessage[] | undefined>
    onEvent?:(event:AgentEvent)=>void
}

async function decideToolCall(
  toolCall: ToolCallContent,
  beforeToolCall:BeforeToolCall | undefined,
  context?: ToolCallContext,
): Promise<ToolDecision> {
    return beforeToolCall ? await beforeToolCall(toolCall, context):{action:"allow"}
}

function createBlockedToolResult(
  toolCall: ToolCallContent,
  reason?: string,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [createTextContent(`Tool call blocked:${reason}`)],
    details: { blocked: true, reason },
    isError: true,
    timestamp: Date.now(),
  };
}

/**
 * 未执行的工具调用的占位结果。
 *
 * 协议要求 assistant 消息里的每个 toolCall 都有对应的 toolResult、且顺序一致。
 * 取消可能落在两个位置：模型刚返回工具调用时、以及一批工具执行到一半时。
 * 若这时直接结束，带 toolCall 的 assistant 消息会以**缺结果**的形态落盘，
 * 之后每轮都从会话文件重建出这条非法序列，请求会被 API 直接拒绝（400），
 * 该会话就此不可用——与压缩切断 assistant/toolResult 配对是同一类问题。
 */
function createNotExecutedToolResult(
  toolCall: ToolCallContent,
  aborted: boolean,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [
      createTextContent(
        aborted
          ? "Tool call cancelled: 本轮已被取消，该工具没有执行"
          : "Tool call skipped: 该工具没有执行",
      ),
    ],
    details: { notExecuted: true, cancelled: aborted },
    isError: true,
    timestamp: Date.now(),
  };
}

/**
 * 给还没有结果的工具调用补上占位结果（按原始顺序），返回本次补齐的部分。
 *
 * 不额外发 `tool_execution_start/end`：卡片缓存靠 start 事件填参数，
 * 只发 end 会让卡片退化成"没有参数、耗时 0ms"的假记录（见 cli-output-presentation）。
 */
function appendNotExecutedToolResults(
  toolCalls: ToolCallContent[],
  slots: Array<ToolResultMessage | undefined>,
  aborted: boolean,
  context: AgentMessage[],
  newMessages: AgentMessage[],
  emit: (event: AgentEvent) => void,
): ToolResultMessage[] {
  const filled: ToolResultMessage[] = [];

  toolCalls.forEach((toolCall, index) => {
    if (slots[index] !== undefined) {
      return;
    }
    const result = createNotExecutedToolResult(toolCall, aborted);
    slots[index] = result;
    context.push(result);
    newMessages.push(result);
    emitMessageLifeCycle(result, emit);
    filled.push(result);
  });

  return filled;
}

function emitMessageLifeCycle(
  message: AgentMessage,
  emit: (event: AgentEvent) => void, 
): void {
  emit({ type: "message_start", message });
  if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "text") {
        emit({ type: "message_update", message, delta: block.text });
      }
    }
  }
  emit({ type: "message_end", message });
}

/**
 * 调用模型并发出完整的消息生命周期：start -> 流式 update -> end。
 *
 * 事件里的 `message` 始终是同一个对象：先作为空占位发出，
 * 模型返回后把最终字段写回该对象，因此消费方看到的三段事件是一致的。
 *
 * 对于不支持流式的模型（含测试替身），补发一次性文本，
 * 保证终端仍然能显示回复，不会因为引入流式而"什么都不打印"。
 */
async function completeAssistantMessage(
  options: RunAgentLoopOptions,
  context: AgentMessage[],
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
): Promise<AssistantMessage> {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    stopReason: "stop",
    usage: { input: 0, output: 0, totalTokens: 0 },
    timestamp: Date.now(),
  };

  let streamed = false;
  emit({ type: "message_start", message });

  try {
    const assistant = await options.model.complete({
      systemPrompt: options.systemPrompt,
      messages: context,
      tools: options.tools,
      signal,
      onDelta: (delta) => {
        streamed = true;
        emit({ type: "message_update", message, delta });
      },
    });
    Object.assign(message, assistant);
  } catch (error) {
    // 模型实现抛错时也要收好生命周期，避免 start 没有对应的 end
    Object.assign(message, {
      content: [createTextContent(error instanceof Error ? error.message : String(error))],
      stopReason: "error" as const,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    streamed = false;
  }

  if (!streamed) {
    for (const block of message.content) {
      if (block.type === "text") {
        emit({ type: "message_update", message, delta: block.text });
      }
    }
  }

  emit({ type: "message_end", message });
  return message;
}


async function executeToolCall(
  toolCall: ToolCallContent,
  toolRegistry: ToolRegistry,
  signal?: AbortSignal,
): Promise<ToolResultMessage> {
  try {
    const result = await toolRegistry.execute(
      toolCall.name,
      toolCall.arguments,
      signal,
    );
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: result.content,
      details: result.details,
      // 工具自己判定失败时（命令非零退出/超时）必须如实带出，
      // 否则卡片会显示 ✅，与"Error: ..."的正文自相矛盾
      isError: result.isError === true,
      timestamp: Date.now(),
    };
  } catch (error) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [createTextContent(error instanceof Error ? error.message : String(error))],
      isError: true,
      timestamp: Date.now(),
    };
  }
}

function createLoopGuardrailMessage(maxTurns:number):AssistantMessage {
    return {
        role:"assistant",
        content:[createTextContent(`Agent Loop已达到最大轮次:${maxTurns},为了避免无限循环已经停止`)],
        stopReason:"error",
        usage:{input:0,output:0,totalTokens:0},
        timestamp:Date.now(),
        errorMessage:"max_turns_exceeded"
    }
}

/**
 * 运行 Agent 循环
 * 
 * @param options - 运行选项
 * @param options.systemPrompt - 系统提示词
 * @param options.messages - 消息历史
 * @param options.tools - 可用工具定义
 * @param options.model - LLM 模型
 * @param options.toolRegistry - 工具注册表
 * @param options.maxTurns - 最大循环轮次，默认值为 100
 * @param options.beforeToolCall - 工具调用前的回调
 * @param options.onEvent - 事件回调
 * @returns 包含新消息和事件的响应
 */
export async function runAgentLoop(options:RunAgentLoopOptions):Promise<{
    newMessages:AgentMessage[],
    events:AgentEvent[]
}> {
    const events:AgentEvent[] = []
    const emit = (event:AgentEvent):void => {
        events.push(event)
        options.onEvent?.(event)
    }
    const context = [...options.messages]
    const newMessages:AgentMessage[] = []
    const maxTurns = options.maxTurns ?? 100
    // 取消信号：外部传入（Ctrl+C）则直接复用，否则内部创建一个（不会被取消的信号）
    const signal = options.signal ?? new AbortController().signal
    emit({type:"agent_start"})

    // 已交给 onTurnEnd 的消息数（调用方负责落盘，循环只负责转发增量）
    let syncedCount = 0

    /**
     * 每轮结束时把本轮新增消息交给调用方（落盘 / 检查压缩）。
     *
     * 单轮内可能跑很多次工具调用，上下文会在一轮里持续增长；
     * 只靠"用户回合开始时压缩一次"不足以兜住，因此这里每轮都给一次机会。
     * 调用方返回新上下文表示已压缩，循环会用它替换内部上下文。
     * 钩子抛错不中断本次运行：持久化与压缩是调用方的职责，它自己会记录。
     */
    const syncTurn = async (): Promise<void> => {
        if (!options.onTurnEnd) {
            return
        }
        const delta = newMessages.slice(syncedCount)
        if (delta.length === 0) {
            return
        }
        syncedCount = newMessages.length
        try {
            const compacted = await options.onTurnEnd(delta)
            if (compacted) {
                context.length = 0
                context.push(...compacted)
            }
        } catch {
            // 忽略：不影响本轮回合继续
        }
    }

    for(let turn=1;turn<=maxTurns;turn++) {
        emit({type:"turn_start",turn})
        const assistant = await completeAssistantMessage(options, context, signal, emit)
        context.push(assistant)
        newMessages.push(assistant)

        const toolCalls = assistant.content.filter((block):block is ToolCallContent=>block.type==="toolCall")
        const slots:Array<ToolResultMessage | undefined> = new Array(toolCalls.length)

        /**
         * 提前收尾本轮。
         *
         * 必须先给没结果的 toolCall 补占位结果再落盘：assistant 消息已经进了
         * context/newMessages，缺结果就会以非法序列写进会话文件
         * （见 appendNotExecutedToolResults）。
         */
        const finishTurnEarly = async (): Promise<{
            newMessages:AgentMessage[],
            events:AgentEvent[]
        }> => {
            const filled = appendNotExecutedToolResults(
                toolCalls, slots, signal.aborted, context, newMessages, emit,
            )
            emit({type:"turn_end",turn,message:assistant,toolResults:filled})
            await syncTurn()
            emit({type:"agent_end",messages:newMessages})
            return {
                newMessages,
                events
            }
        }

        if(assistant.stopReason==="error" || assistant.stopReason==="aborted") {
            return await finishTurnEarly()
        }

        // 兜底：模型实现未响应取消信号时，这里不再继续执行工具
        if(signal.aborted) {
            return await finishTurnEarly()
        }

        if(toolCalls.length===0) {
            return await finishTurnEarly()
        }

        /**
         * 执行一批工具调用。
         *
         * 只读工具（read_file / glob / grep / list_files）会批量并发执行：
         * 模型经常一次发多个读取类调用，串行等于把延迟叠加。
         * 写类工具始终单独执行（一次一个），避免互相踩状态。
         *
         * 无论并发与否，结果都按**原始顺序**归档到 slots / context / newMessages，
         * 因为协议要求 toolResult 与 toolCall 一一对应且顺序一致。
         */
        const runBatch = async (indices:number[]):Promise<void> => {
            const decisions = await Promise.all(
                indices.map((index) => decideToolCall(toolCalls[index], options.beforeToolCall, options.identity)),
            )

            const executables = new Map<number,ToolCallContent>()
            const blocked = new Map<number,ToolResultMessage>()

            indices.forEach((index,position) => {
                const toolCall = toolCalls[index]
                const decision = decisions[position]

                if(decision.action!=="allow") {
                    emit({
                        type:"tool_permission",
                        toolCallId:toolCall.id,
                        toolName:toolCall.name,
                        action:decision.action,
                        reason:decision.reason,
                        originalArgs:toolCall.arguments,
                        args:decision.action==="rewrite"?decision.args:toolCall.arguments
                    })
                }

                if(decision.action==="block") {
                    blocked.set(index, createBlockedToolResult(toolCall,decision.reason))
                    return
                }

                const executable = decision.action==="rewrite"?{...toolCall,arguments:decision.args}:toolCall
                executables.set(index, executable)
                emit({
                    type:"tool_execution_start",
                    toolCallId:executable.id,
                    toolName:executable.name,
                    args:executable.arguments
                })
            })

            const executed = new Map<number,ToolResultMessage>()
            await Promise.all(
                [...executables.entries()].map(async ([index,executable]) => {
                    executed.set(index, await executeToolCall(executable, options.toolRegistry, signal))
                }),
            )

            for(const index of indices) {
                const blockedResult = blocked.get(index)
                if(blockedResult) {
                    slots[index] = blockedResult
                    context.push(blockedResult)
                    newMessages.push(blockedResult)
                    emitMessageLifeCycle(blockedResult, emit)
                    continue
                }

                const executable = executables.get(index)
                const toolResult = executed.get(index)
                if(!executable || !toolResult) {
                    continue
                }

                slots[index] = toolResult
                context.push(toolResult)
                newMessages.push(toolResult)

                emit({
                    type:"tool_execution_end",
                    toolCallId: executable.id,
                    toolName: executable.name,
                    result:{
                        content:toolResult.content,
                        details:toolResult.details
                    },
                    isError:toolResult.isError
                })
                emitMessageLifeCycle(toolResult, emit)
            }
        }

        let cursor = 0
        while(cursor < toolCalls.length) {
            if(signal.aborted) {
                break
            }

            if(options.toolRegistry.isReadOnly(toolCalls[cursor].name)) {
                // 收集连续的只读调用，一起并发
                const batch:number[] = []
                while(
                    cursor + batch.length < toolCalls.length &&
                    options.toolRegistry.isReadOnly(toolCalls[cursor + batch.length].name)
                ) {
                    batch.push(cursor + batch.length)
                }
                await runBatch(batch)
                cursor += batch.length
                continue
            }

            await runBatch([cursor])
            cursor += 1
        }

        // 取消可能落在一批工具执行到一半：未执行的 toolCall 同样要补结果，
        // 否则 slots 缺项，落盘后就是"缺结果"的非法序列
        appendNotExecutedToolResults(
            toolCalls, slots, signal.aborted, context, newMessages, emit,
        )

        const toolResults = slots.filter(
            (result):result is ToolResultMessage => result !== undefined,
        )

        emit({type:"turn_end",turn,message:assistant,toolResults})

        // 每轮结束都落盘并检查一次压缩：单轮内的上下文同样可能超出预算
        await syncTurn()

        // 被取消：不再进入下一轮
        if(signal.aborted) {
            emit({type:"agent_end",messages:newMessages})
            return {
                newMessages,
                events
            }
        }
        
    }

    const guardrail = createLoopGuardrailMessage(maxTurns)
    newMessages.push(guardrail)
    emitMessageLifeCycle(guardrail,emit)
    emit({type:"agent_end",messages:newMessages})
    return {
        newMessages,
        events
    }
}
