import { AgentMessage, Usage } from "../shared/protocol";

/**
 * token 用量统计。
 *
 * 此前每条 assistant 消息都带着 `usage`（模型返回），但没有人累加：
 * 跑了一整晚也不知道花了多少 token，`/status` 里更看不到。
 * 这里把"累加"与"展示格式"做成纯函数，CLI 只负责在合适的时机喂消息。
 *
 * 统计口径是**进程内本次会话**：切会话（/new、/switch）与 /clear 会清零，
 * 因此它反映的是"当前这个会话到目前为止"的消耗，而不是整个进程的消耗。
 */

export type UsageSnapshot = {
  input: number;
  output: number;
  totalTokens: number;
  /** 已完成的模型请求次数（含失败与取消的那一次） */
  requests: number;
  /** 上一轮（最近一次用户回合）的用量 */
  lastTurn: Usage | null;
  /** 提供方是否至少回过一次真实用量（用于区分"没统计到"和"确实用了 0"） */
  reported: boolean;
};

export function emptyUsage(): Usage {
  return { input: 0, output: 0, totalTokens: 0 };
}

/** 用量相加：缺失字段按 0 处理（模型实现可能不返回 usage） */
export function addUsage(base: Usage, extra: Usage | undefined): Usage {
  if (!extra) {
    return base;
  }
  return {
    input: base.input + (extra.input ?? 0),
    output: base.output + (extra.output ?? 0),
    totalTokens: base.totalTokens + (extra.totalTokens ?? 0),
  };
}

/**
 * 累加一批消息里的 assistant 用量。
 *
 * 只算 assistant 消息：一条 assistant 消息对应一次模型请求，
 * 用户输入与工具结果本身不产生 token 消耗（它们体现在下一轮的 input 里）。
 */
export function sumUsage(messages: readonly AgentMessage[]): {
  usage: Usage;
  requests: number;
  reported: boolean;
} {
  let usage = emptyUsage();
  let requests = 0;
  let reported = false;

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    requests += 1;
    usage = addUsage(usage, message.usage);
    if ((message.usage?.totalTokens ?? 0) > 0) {
      reported = true;
    }
  }

  return { usage, requests, reported };
}

/** 紧凑的数字：1234 → "1.2k"，3_400_000 → "3.40M" */
export function formatTokenCount(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  if (safe < 1_000) {
    return String(safe);
  }
  if (safe < 1_000_000) {
    return `${(safe / 1_000).toFixed(1)}k`;
  }
  return `${(safe / 1_000_000).toFixed(2)}M`;
}

/**
 * `/status` 里的用量文案。
 *
 * 两种"看不到消耗"要区分开：
 * - 一次请求都还没发：`尚无模型调用`；
 * - 发过请求但提供方没返回 usage（例如关掉了 stream_options）：明确说出来，
 *   否则用户会以为真的没花钱。
 */
export function formatUsage(snapshot: UsageSnapshot): string {
  if (snapshot.requests === 0) {
    return "尚无模型调用";
  }
  if (!snapshot.reported || snapshot.totalTokens === 0) {
    return `${snapshot.requests} 次请求（提供方未返回用量数据）`;
  }

  const parts = [
    `输入 ${formatTokenCount(snapshot.input)}`,
    `输出 ${formatTokenCount(snapshot.output)}`,
    `合计 ${formatTokenCount(snapshot.totalTokens)}`,
    `${snapshot.requests} 次请求`,
  ];
  if (snapshot.lastTurn && snapshot.lastTurn.totalTokens > 0) {
    parts.push(`上一轮 ${formatTokenCount(snapshot.lastTurn.totalTokens)}`);
  }
  return parts.join(" · ");
}

export type UsageTracker = {
  /** 记录一轮（或一批）消息：累加总量，并把其中的 assistant 用量记为"上一轮" */
  recordTurn(messages: readonly AgentMessage[]): void;
  snapshot(): UsageSnapshot;
  /** 清零：切会话或清历史后重新计数 */
  reset(): void;
};

export function createUsageTracker(): UsageTracker {
  let total = emptyUsage();
  let requests = 0;
  let reported = false;
  let lastTurn: Usage | null = null;

  return {
    recordTurn(messages): void {
      const { usage, requests: count, reported: gotUsage } = sumUsage(messages);
      if (count === 0) {
        return;
      }
      total = addUsage(total, usage);
      requests += count;
      reported = reported || gotUsage;
      lastTurn = usage;
    },
    snapshot(): UsageSnapshot {
      return {
        input: total.input,
        output: total.output,
        totalTokens: total.totalTokens,
        requests,
        lastTurn,
        reported,
      };
    },
    reset(): void {
      total = emptyUsage();
      requests = 0;
      reported = false;
      lastTurn = null;
    },
  };
}
