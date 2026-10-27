import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AgentMessage } from "../shared/protocol";
import { logger } from "../shared/logger";

/**
 * 子 Agent 的 trace 落盘（批次 D3）。
 *
 * 委派本身以一条 toolCall/toolResult 进主会话，但子 Agent **内部**的来回不进：
 * 排障时看不到它读了哪些文件、在哪一轮跑偏、为什么给出这个结论。
 * 打开后每次委派写一份 `<会话名>.sub-<agentId>.jsonl`，与主会话同格式（JSON Lines），
 * 可以直接 `jq` / 逐行看。
 *
 * 三条硬约束：
 * 1. **默认关闭**：trace 是磁盘上额外的敏感数据副本，不能在用户不知情时产生；
 * 2. **写失败不许影响委派**：排障手段绝不能反过来搞崩被排障的流程，
 *    失败只记一条诊断日志；
 * 3. **不吞工具参数**：子 Agent 的价值恰恰在"它查了什么"，
 *    只记结论的 trace 等于没写。
 */

export type SubAgentTraceWriter = {
  /** 记录一条消息 */
  write: (message: AgentMessage) => Promise<void>;
  /** 记录一条事件（tool_execution_start/end 等） */
  writeEvent: (event: unknown) => Promise<void>;
  /** 收尾：把路径告诉调用方（或写失败时为 null） */
  close: () => Promise<string | null>;
};

/** trace 里的一条记录 */
type TraceRecord =
  | { type: "message"; message: AgentMessage }
  | { type: "event"; event: unknown };

/**
 * 为一次委派创建 trace 写入器。
 *
 * @param sessionFilePath 主会话文件路径；trace 落在它旁边，命名规则保持一致
 * @param agentId 子 Agent id，用于让每次委派一个独立文件
 * @returns 写入器；`enabled` 为 false 时是一个什么都不做的空实现
 */
export function createSubAgentTraceWriter(input: {
  enabled: boolean;
  sessionFilePath: string | null;
  agentId: string;
}): SubAgentTraceWriter {
  if (!input.enabled || !input.sessionFilePath) {
    return {
      write: async (): Promise<void> => {},
      writeEvent: async (): Promise<void> => {},
      close: async (): Promise<string | null> => null,
    };
  }

  // `<会话>.jsonl` → `<会话>.sub-<id>.jsonl`；拿不到扩展名时直接追加
  const base = input.sessionFilePath.replace(/\.jsonl$/, "");
  const tracePath = `${base}.sub-${input.agentId}.jsonl`;

  /**
   * 写入串行化。
   *
   * 事件是 fire-and-forget 发进来的（`void trace.writeEvent(...)`），
   * 多个 `appendFile` 同时打开同一个文件时**顺序不保证**：trace 里会出现
   * "工具结果排在工具调用前面"这种误导性顺序。`close` 也必须等队列清空，
   * 否则委派一结束就返回路径，最后几条事件还没落盘。
   */
  let queue: Promise<void> = Promise.resolve();

  const append = (record: TraceRecord): Promise<void> => {
    const current = queue.then(async () => {
      try {
        await mkdir(dirname(tracePath), { recursive: true });
        await appendFile(tracePath, `${JSON.stringify(record)}\n`, "utf8");
      } catch (error) {
        logger.warn(
          `子 Agent trace 写入失败（已忽略，不影响委派本身）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
    queue = current;
    return current;
  };

  return {
    write: async (message: AgentMessage): Promise<void> => {
      await append({ type: "message", message });
    },
    writeEvent: async (event: unknown): Promise<void> => {
      await append({ type: "event", event });
    },
    close: async (): Promise<string | null> => {
      // 收尾前把排队中的记录全部写完：返回路径意味着"文件已经可用"
      await queue;
      return tracePath;
    },
  };
}
