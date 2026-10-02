import { AgentEvent, AgentMessage, AssistantMessage, ToolCallContent, ToolDefinition, ToolResult, ToolResultMessage } from "../shared/protocol";
import { createTextContent } from "./message";
import { LlmModel } from "./model";
import { ToolRegistry } from "./tools";


export type ToolDecision = 
    | {action:"allow";reason?:string}
    | {action:"block";reason?:string}
    | {action:"rewrite",args:Record<string,unknown>;reason?:string}
export type BeforeToolCall = (call:ToolCallContent)=>Promise<ToolDecision>

export type RunAgentLoopOptions = {
    systemPrompt:string
    messages:AgentMessage[]
    tools:ToolDefinition[]
    model:LlmModel
    toolRegistry:ToolRegistry
    /** 最大循环轮次，默认值为 100 */
    maxTurns?:number
    beforeToolCall?:BeforeToolCall
    /** 外部取消信号（例如 Ctrl+C）：中止模型请求与正在执行的工具 */
    signal?:AbortSignal
    onEvent?:(event:AgentEvent)=>void
}

async function decideToolCall(
  toolCall: ToolCallContent,
  beforeToolCall:BeforeToolCall | undefined
): Promise<ToolDecision> {
    return beforeToolCall ? await beforeToolCall(toolCall):{action:"allow"}
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
      isError: false,
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

    for(let turn=1;turn<=maxTurns;turn++) {
        emit({type:"turn_start",turn})
        const assistant = await completeAssistantMessage(options, context, signal, emit)
        context.push(assistant)
        newMessages.push(assistant)

        if(assistant.stopReason==="error" || assistant.stopReason==="aborted") {
            emit({type:"turn_end",turn,message:assistant,toolResults:[]})
            emit({type:"agent_end",messages:newMessages})
            return {
                newMessages,
                events
            }
        }

        // 兜底：模型实现未响应取消信号时，这里不再继续执行工具
        if(signal.aborted) {
            emit({type:"turn_end",turn,message:assistant,toolResults:[]})
            emit({type:"agent_end",messages:newMessages})
            return {
                newMessages,
                events
            }
        }

        const toolCalls = assistant.content.filter((block):block is ToolCallContent=>block.type==="toolCall")
        if(toolCalls.length===0) {
            emit({type:"turn_end",turn,message:assistant,toolResults:[]})
            emit({type:"agent_end",messages:newMessages})
            return {
                newMessages,
                events
            }
        }

        const toolResults:ToolResultMessage[] = []

        for(const toolCall of toolCalls) {
            if(signal.aborted) {
                break
            }
            const decision = await decideToolCall(toolCall,options.beforeToolCall);
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
                const blockedResult = createBlockedToolResult(toolCall,decision.reason)
                toolResults.push(blockedResult)
                context.push(blockedResult)
                newMessages.push(blockedResult)
                emitMessageLifeCycle(blockedResult, emit);
                continue
            }
            const executableToolCall = decision.action==="rewrite"?{...toolCall,arguments:decision.args}:toolCall

            emit({
                type:"tool_execution_start",
                toolCallId:executableToolCall.id,
                toolName:executableToolCall.name,
                args:executableToolCall.arguments
            })

            const toolResult = await executeToolCall(executableToolCall,options.toolRegistry, signal)

            toolResults.push(toolResult)
            context.push(toolResult)
            newMessages.push(toolResult)

            emit({
                type:"tool_execution_end",
                toolCallId: executableToolCall.id,
                toolName: executableToolCall.name,
                result:{
                    content:toolResult.content,
                    details:toolResult.details
                },
                isError:toolResult.isError
            })
            emitMessageLifeCycle(toolResult, emit);
        }

        emit({type:"turn_end",turn,message:assistant,toolResults})

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
