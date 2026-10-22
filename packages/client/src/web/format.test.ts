/**
 * 展示格式化的测试：同一份数据在时间线、运行头、侧栏三处出现，
 * 写法必须只有一种。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage, ToolResultMessage } from "@minipi/core/shared/protocol";
import {
  CONTEXT_WARN_PCT,
  contextPercent,
  formatDuration,
  formatSessionTime,
  formatTokens,
  resultText,
  riskMeta,
  statusMeta,
  textOf,
  tierLabel,
  toolMetaLine,
  TIER_LABELS,
} from "./format";
import type { Tier } from "../shared/types";

describe("formatDuration", () => {
  it("十秒以内给到 0.1s", () => {
    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(3400), "3.4s");
    assert.equal(formatDuration(9900), "9.9s");
  });

  it("十秒以上按整秒，一分钟以上带分钟", () => {
    assert.equal(formatDuration(12_400), "12s");
    assert.equal(formatDuration(61_000), "1m 01s");
    assert.equal(formatDuration(125_000), "2m 05s");
  });

  it("非法输入不炸", () => {
    assert.equal(formatDuration(-5), "0s");
    assert.equal(formatDuration(Number.NaN), "0s");
  });
});

describe("formatTokens", () => {
  it("小数直接取整，千位缩成 k，百万缩成 M", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(420), "420");
    assert.equal(formatTokens(8200), "8.2k");
    assert.equal(formatTokens(128_000), "128k");
    assert.equal(formatTokens(1_280_000), "1.28M");
  });
});

describe("formatSessionTime", () => {
  it("把文件名里的时间戳还原成可读形式", () => {
    assert.equal(formatSessionTime("2026-10-20T09-14-02"), "2026-10-20 09:14");
  });

  it("认不出的时间戳原样返回", () => {
    assert.equal(formatSessionTime("whatever"), "whatever");
  });
});

describe("状态与风险徽标", () => {
  it("颜色与文字双重编码：每个状态都有文案", () => {
    assert.equal(statusMeta("running").label, "运行中");
    assert.equal(statusMeta("blocked").tone, "amber");
    assert.equal(statusMeta("idle").label, "空闲");
  });

  it("风险等级只做映射，不做判断", () => {
    assert.equal(riskMeta("high").label, "高危");
    assert.equal(riskMeta("high").tone, "rose");
    assert.equal(riskMeta("none").label, "待确认");
  });
});

describe("消息正文", () => {
  it("textOf 拼接文本段、跳过工具调用段", () => {
    const message: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "第一段" },
        { type: "toolCall", id: "c1", name: "read_file", arguments: {} },
        { type: "text", text: "第二段" },
      ],
      stopReason: "stop",
      usage: { input: 1, output: 1, totalTokens: 2 },
      timestamp: 1,
    };
    assert.equal(textOf(message), "第一段\n第二段");
  });

  it("resultText 拼工具结果的所有段", () => {
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read_file",
      content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
      isError: false,
      timestamp: 1,
    };
    assert.equal(resultText(result), "a\nb");
    assert.equal(textOf(result), "a\nb");
  });
});

describe("toolMetaLine", () => {
  it("失败必带字样，耗时可选", () => {
    assert.equal(toolMetaLine(null, "failed"), "失败");
    assert.equal(toolMetaLine(1500, "failed"), "1.5s · 失败");
    assert.equal(toolMetaLine(1500, "done"), "1.5s");
    assert.equal(toolMetaLine(null, "running"), "");
  });
});

describe("contextPercent", () => {
  it("按占比取整", () => {
    assert.equal(contextPercent(0, 128_000), 0);
    assert.equal(contextPercent(64_000, 128_000), 50);
    assert.equal(contextPercent(1, 3), 33);
  });

  it("超额也钳在 100：快满了靠换色说，不靠进度条爆表", () => {
    assert.equal(contextPercent(200_000, 128_000), 100);
  });

  it("没有分母（没配模型、窗口未知）时是 0，不给假百分比", () => {
    assert.equal(contextPercent(500, 0), 0);
    assert.equal(contextPercent(500, Number.NaN), 0);
    assert.equal(contextPercent(Number.NaN, 1000), 0);
    assert.equal(contextPercent(-5, 1000), 0);
  });

  it("警戒线在八成", () => {
    assert.equal(CONTEXT_WARN_PCT, 80);
    assert.equal(contextPercent(102_400, 128_000) >= CONTEXT_WARN_PCT, true);
    assert.equal(contextPercent(51_200, 128_000) >= CONTEXT_WARN_PCT, false);
  });
});

describe("档位文案", () => {
  it("三档都有中文名，认不出的档位原样返回（不静默改写）", () => {
    assert.equal(tierLabel("read-only"), "只读");
    assert.equal(tierLabel("workspace-write"), "工作区写");
    assert.equal(tierLabel("full-access"), "完全访问");
    assert.equal(tierLabel("mystery" as Tier), "mystery");
  });

  it("每档都带说明：档位是安全语义，不能只给一个名字", () => {
    for (const item of TIER_LABELS) {
      assert.ok(item.hint.length > 0, `${item.tier} 应有说明`);
    }
    assert.equal(TIER_LABELS.length, 3);
  });
});
