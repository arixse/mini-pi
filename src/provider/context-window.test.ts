import { describe, it } from "node:test";
import assert from "node:assert";
import {
  DEFAULT_CONTEXT_WINDOW,
  inferContextWindow,
  matchContextWindowRule,
  normalizeModelName,
  resolveContextWindow,
} from "./context-window";

describe("normalizeModelName", () => {
  it("去空白、转小写、去掉供应商前缀", () => {
    assert.strictEqual(normalizeModelName("  MiniMax-M2.7  "), "minimax-m2.7");
    assert.strictEqual(normalizeModelName("minimax-cn/MiniMax-M3"), "minimax-m3");
    assert.strictEqual(normalizeModelName("openai/gpt-4o"), "gpt-4o");
  });

  it("空串仍是空串（调用方据此判断未命中）", () => {
    assert.strictEqual(normalizeModelName(""), "");
    assert.strictEqual(normalizeModelName("   "), "");
  });
});

describe("inferContextWindow（按模型名推断）", () => {
  it("认不出模型名时回退到默认 128k", () => {
    assert.strictEqual(inferContextWindow(undefined), DEFAULT_CONTEXT_WINDOW);
    assert.strictEqual(inferContextWindow(null), DEFAULT_CONTEXT_WINDOW);
    assert.strictEqual(inferContextWindow(""), DEFAULT_CONTEXT_WINDOW);
    assert.strictEqual(inferContextWindow("一个不存在的模型"), DEFAULT_CONTEXT_WINDOW);
    // 自动创建默认配置时会写入的占位模型名，同样回退
    assert.strictEqual(inferContextWindow("default"), DEFAULT_CONTEXT_WINDOW);
  });

  it("小窗口模型必须被认出来（估大会让请求超窗 400）", () => {
    assert.strictEqual(inferContextWindow("gpt-3.5-turbo"), 16_384);
    assert.strictEqual(inferContextWindow("gpt-3.5-turbo-16k"), 16_384);
    assert.strictEqual(inferContextWindow("gpt-4"), 8_192);
    assert.strictEqual(inferContextWindow("gpt-4-0613"), 8_192);
    assert.strictEqual(inferContextWindow("gpt-4-32k"), 32_768);
    assert.strictEqual(inferContextWindow("MiniMax-M2-her"), 65_536);
  });

  it("128k 量级的常见模型", () => {
    assert.strictEqual(inferContextWindow("gpt-4o"), 128_000);
    assert.strictEqual(inferContextWindow("gpt-4o-mini"), 128_000);
    assert.strictEqual(inferContextWindow("gpt-4o-2024-08-06"), 128_000);
    assert.strictEqual(inferContextWindow("gpt-4-turbo"), 128_000);
    assert.strictEqual(inferContextWindow("o1-mini"), 128_000);
    assert.strictEqual(inferContextWindow("deepseek-chat"), 128_000);
    assert.strictEqual(inferContextWindow("deepseek-reasoner"), 128_000);
    assert.strictEqual(inferContextWindow("deepseek-flash"), 128_000);
  });

  it("大窗口模型", () => {
    assert.strictEqual(inferContextWindow("o1"), 200_000);
    assert.strictEqual(inferContextWindow("o3-mini"), 200_000);
    assert.strictEqual(inferContextWindow("o4-mini"), 200_000);
    assert.strictEqual(inferContextWindow("MiniMax-M2"), 204_800);
    assert.strictEqual(inferContextWindow("MiniMax-M2.7"), 204_800);
    assert.strictEqual(inferContextWindow("MiniMax-M2.5-highspeed"), 204_800);
    assert.strictEqual(inferContextWindow("MiniMax-M3"), 1_000_000);
  });

  it("小米 MiMo 系列", () => {
    assert.strictEqual(inferContextWindow("mimo-v2.6-pro"), 1_000_000);
    assert.strictEqual(inferContextWindow("mimo-v2.6-flash"), 1_000_000);
    assert.strictEqual(inferContextWindow("mimo-v2.6-pro-ultraspeed"), 1_000_000);
    assert.strictEqual(inferContextWindow("mimo-v2.5-pro"), 1_000_000);
    assert.strictEqual(inferContextWindow("mimo-v2.5"), 1_000_000);
    // 小窗口模型必须被认出来，否则会在压缩触发前超窗（400）
    assert.strictEqual(inferContextWindow("mimo-7b-instruct"), 32_768);
  });

  it("MiMo 的窗口不能被同前缀的更通用条目盖掉", () => {
    // 最长前缀优先：omni（128K）不能落到 mimo-v2.5 的 1M 上
    assert.strictEqual(inferContextWindow("mimo-v2.5-omni"), 131_072);
    assert.strictEqual(
      matchContextWindowRule("mimo-v2.6-pro-ultraspeed")?.prefix,
      "mimo-v2.6-pro-ultraspeed",
    );
  });

  it("带供应商前缀与大小写混写同样命中", () => {
    assert.strictEqual(inferContextWindow("minimax-cn/MiniMax-M2.7"), 204_800);
    assert.strictEqual(inferContextWindow("openai/GPT-3.5-Turbo"), 16_384);
    assert.strictEqual(inferContextWindow("mimo/MiMo-V2.6-Pro"), 1_000_000);
    assert.strictEqual(inferContextWindow("kimi/Kimi-K3"), 1_000_000);
  });

  it("Kimi（Moonshot）系列", () => {
    assert.strictEqual(inferContextWindow("kimi-k3"), 1_000_000);
    assert.strictEqual(inferContextWindow("kimi-k2.6"), 262_144);
    assert.strictEqual(inferContextWindow("kimi-k2.7-code"), 262_144);
    assert.strictEqual(inferContextWindow("kimi-k2.7-code-highspeed"), 262_144);
  });

  it("Kimi 的高速版不能被 kimi-k2.7 的通用条目盖掉", () => {
    // 两者同为 256K，这里断言的是"最长前缀优先"没被破坏
    assert.strictEqual(
      matchContextWindowRule("kimi-k2.7-code-highspeed")?.prefix,
      "kimi-k2.7-code-highspeed",
    );
    // K3 是 1M，不能被任何 k2 条目命中
    assert.strictEqual(matchContextWindowRule("kimi-k3")?.prefix, "kimi-k3");
  });

  it("Anthropic Claude 当前一代", () => {
    assert.strictEqual(inferContextWindow("claude-opus-5-5"), 1_000_000);
    assert.strictEqual(inferContextWindow("claude-sonnet-5-5"), 1_000_000);
    assert.strictEqual(inferContextWindow("claude-fable-5-1"), 1_000_000);
    // Haiku 4.5 只有 200K，不能被 1M 的通用条目盖住
    assert.strictEqual(inferContextWindow("claude-haiku-4-5"), 200_000);
    assert.strictEqual(inferContextWindow("claude-haiku-4-5-20251001"), 200_000);
  });

  it("Claude 4.x 按 200K 登记（1M 需 beta 头，估大会超窗 400）", () => {
    assert.strictEqual(inferContextWindow("claude-opus-4-8"), 200_000);
    assert.strictEqual(inferContextWindow("claude-sonnet-4-5"), 200_000);
    assert.strictEqual(inferContextWindow("claude-3-5-sonnet-20241022"), 200_000);
    // 认不出具体型号的 Claude 兜底到 200K，而不是全局默认的 128K
    assert.strictEqual(inferContextWindow("claude-some-future-model"), 200_000);
  });
});

describe("matchContextWindowRule（最长前缀优先）", () => {
  it("gpt-4o 不能落到 gpt-4 的 8k 上", () => {
    //  regressions：最长前缀被短前缀盖掉时，gpt-4o 会被当成 8k 窗口，
    //  压缩会在 8000 token 就触发（阈值下限），等于每轮都压
    assert.strictEqual(matchContextWindowRule("gpt-4o")?.prefix, "gpt-4o");
    assert.strictEqual(matchContextWindowRule("gpt-4o-mini")?.window, 128_000);
    assert.strictEqual(matchContextWindowRule("gpt-4-32k")?.prefix, "gpt-4-32k");
  });

  it("MiniMax-M3 不能落到 minimax-m2 的 204.8k 上", () => {
    assert.strictEqual(matchContextWindowRule("MiniMax-M3")?.window, 1_000_000);
    assert.strictEqual(
      matchContextWindowRule("MiniMax-M2-her")?.prefix,
      "minimax-m2-her",
    );
  });

  it("未命中返回 null", () => {
    assert.strictEqual(matchContextWindowRule("unknown-model"), null);
    assert.strictEqual(matchContextWindowRule(null), null);
  });
});

describe("resolveContextWindow（配置 > 推断 > 默认）", () => {
  it("显式配置优先，且标注来源为 configured", () => {
    const resolved = resolveContextWindow({
      configured: 64_000,
      modelName: "MiniMax-M2.7",
    });
    assert.deepStrictEqual(resolved, { window: 64_000, source: "configured" });
  });

  it("非法配置值（0 / 负数 / NaN / 无穷）等同未配置", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const resolved = resolveContextWindow({
        configured: bad,
        modelName: "deepseek-chat",
      });
      assert.deepStrictEqual(
        resolved,
        { window: 128_000, source: "inferred" },
        `configured=${String(bad)} 应被忽略`,
      );
    }
  });

  it("未配置但认得模型名：按模型名推断，来源为 inferred", () => {
    const resolved = resolveContextWindow({ modelName: "gpt-3.5-turbo" });
    assert.deepStrictEqual(resolved, { window: 16_384, source: "inferred" });
  });

  it("未配置且认不出模型名：落到默认值，来源为 default", () => {
    const resolved = resolveContextWindow({ modelName: "某个私有模型" });
    assert.deepStrictEqual(resolved, {
      window: DEFAULT_CONTEXT_WINDOW,
      source: "default",
    });
    assert.strictEqual(
      resolveContextWindow({}).window,
      DEFAULT_CONTEXT_WINDOW,
      "连模型名都没有时同样用默认值",
    );
  });

  it("配置值向下取整，避免出现小数窗口", () => {
    assert.strictEqual(
      resolveContextWindow({ configured: 12_345.6 }).window,
      12_345,
    );
  });
});
