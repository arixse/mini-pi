import { describe, it } from "node:test";
import assert from "node:assert";
import {
  CONTEXT_WINDOW_RULES,
  DEFAULT_CONTEXT_WINDOW,
  PROVIDER_CONTEXT_WINDOW_OVERRIDES,
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
  });

  it("OpenAI 当前一代：GPT-6 与 GPT-5.4+ 都是 1.05M", () => {
    // 估小只是多压缩几次；估大会在压缩触发前超窗（400），所以这里逐个钉住
    assert.strictEqual(inferContextWindow("gpt-6-astra"), 1_050_000);
    assert.strictEqual(inferContextWindow("gpt-6.1-sol"), 1_050_000);
    assert.strictEqual(inferContextWindow("gpt-6-luna"), 1_050_000);
    assert.strictEqual(inferContextWindow("gpt-5.6-sol"), 1_050_000);
    assert.strictEqual(inferContextWindow("gpt-5.5"), 1_050_000);
    assert.strictEqual(inferContextWindow("gpt-5.4"), 1_050_000);
    // GPT-5 ~ 5.3 是 400K
    assert.strictEqual(inferContextWindow("gpt-5"), 400_000);
    assert.strictEqual(inferContextWindow("gpt-5.2-codex"), 400_000);
    assert.strictEqual(inferContextWindow("gpt-4.1"), 1_000_000);
    assert.strictEqual(inferContextWindow("gpt-4.1-mini"), 1_000_000);
    // Spark 只有 128K，落到 gpt-5 的 400K 上会超窗
    assert.strictEqual(inferContextWindow("gpt-5.3-codex-spark"), 128_000);
    assert.strictEqual(
      matchContextWindowRule("gpt-5.3-codex-spark")?.prefix,
      "gpt-5.3-codex-spark",
    );
  });

  it("DeepSeek V4 起是 1M（官方定价页）", () => {
    assert.strictEqual(inferContextWindow("deepseek-flash"), 1_000_000);
    assert.strictEqual(inferContextWindow("deepseek-v4-pro"), 1_000_000);
    // 整条 deepseek 前缀共用一条规则：官方换代（V3 → V4）后不必逐个型号追着改
    assert.strictEqual(matchContextWindowRule("deepseek-v4-flash")?.window, 1_000_000);
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

  it("小米 MiMo 系列（只登记在售型号）", () => {
    assert.strictEqual(inferContextWindow("mimo-v2.6-pro"), 1_000_000);
    assert.strictEqual(inferContextWindow("mimo-v2.6-flash"), 1_000_000);
    assert.strictEqual(inferContextWindow("mimo-v2.6-pro-ultraspeed"), 1_000_000);
    // 小窗口模型必须被认出来，否则会在压缩触发前超窗（400）
    assert.strictEqual(inferContextWindow("mimo-7b-instruct"), 32_768);
  });

  it("已下线的 MiMo 型号不再登记（调用即 404，留着只会误导）", () => {
    // V2.5 / V2.5-Pro 于 2026-10-21 下线，V2 / V2-Omni / V2-Flash 于 2026-06-30 下线
    for (const name of [
      "mimo-v2.5-pro",
      "mimo-v2.5",
      "mimo-v2.5-omni",
      "mimo-v2-pro",
      "mimo-v2-omni",
      "mimo-v2-flash",
    ]) {
      assert.strictEqual(matchContextWindowRule(name), null, `${name} 不应再有窗口规则`);
    }
  });

  it("MiMo 的高速版不能被更通用的条目盖掉", () => {
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
    assert.strictEqual(inferContextWindow("zhipu/GLM-5.3"), 1_000_000);
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

  it("智谱 GLM 系列", () => {
    assert.strictEqual(inferContextWindow("glm-5.3"), 1_000_000);
    assert.strictEqual(inferContextWindow("glm-5.2"), 1_000_000);
    assert.strictEqual(inferContextWindow("glm-5.1"), 200_000);
    assert.strictEqual(inferContextWindow("glm-5"), 200_000);
    assert.strictEqual(inferContextWindow("glm-5-turbo"), 200_000);
    assert.strictEqual(inferContextWindow("glm-4.7"), 200_000);
    assert.strictEqual(inferContextWindow("glm-4.6"), 200_000);
    assert.strictEqual(inferContextWindow("glm-4.5-air"), 128_000);
    // 小窗口的视觉模型必须被认出来，否则会在压缩触发前超窗（400）
    assert.strictEqual(inferContextWindow("glm-4.1v-thinking-flashx"), 65_536);
    assert.strictEqual(inferContextWindow("glm-4v-flash"), 16_384);
    // AutoGLM-Phone 官方标 20K，不登记会落到 128K 默认值
    assert.strictEqual(inferContextWindow("autoglm-phone"), 20_480);
  });

  it("GLM 的同前缀模型不能被更通用的条目盖掉", () => {
    // GLM-4-Long 是 1M，不能被 glm-4 的 128K 盖住
    assert.strictEqual(inferContextWindow("glm-4-long"), 1_000_000);
    assert.strictEqual(matchContextWindowRule("glm-4-long")?.prefix, "glm-4-long");
    // GLM-4.6V 是 128K 的视觉模型，不能被 GLM-4.6 的 200K 盖住
    assert.strictEqual(inferContextWindow("glm-4.6v"), 128_000);
    assert.strictEqual(matchContextWindowRule("glm-4.6v")?.prefix, "glm-4.6v");
    // GLM-4-FlashX 落到 glm-4 的 128K
    assert.strictEqual(inferContextWindow("glm-4-flashx-250414"), 128_000);
  });

  it("阿里百炼 Qwen 系列", () => {
    assert.strictEqual(inferContextWindow("qwen3.8-max"), 1_000_000);
    assert.strictEqual(inferContextWindow("qwen3.8-max-0902"), 1_000_000);
    assert.strictEqual(inferContextWindow("qwen3.8-flash"), 1_000_000);
    assert.strictEqual(inferContextWindow("qwen3.7-plus"), 1_000_000);
    assert.strictEqual(inferContextWindow("qwen3.7-flash-2026-07-15"), 1_000_000);
    assert.strictEqual(inferContextWindow("qwen3-coder-flash"), 1_000_000);
    assert.strictEqual(inferContextWindow("qwen3.6-plus"), 1_000_000);
    assert.strictEqual(inferContextWindow("qwen3.5-plus"), 1_000_000);
    assert.strictEqual(inferContextWindow("qwen3.5-flash"), 1_000_000);
    assert.strictEqual(inferContextWindow("qwen-plus"), 1_000_000);
    assert.strictEqual(inferContextWindow("qwen-flash"), 1_000_000);
    // 开源型号与 omni 是 256K，不能被 1M 的 plus/flash 条目吞掉
    assert.strictEqual(inferContextWindow("qwen3.5-397b-a17b"), 262_144);
    assert.strictEqual(inferContextWindow("qwen3.5-omni-plus"), 262_144);
    assert.strictEqual(inferContextWindow("qwen-long"), 10_000_000);
    // 小窗口模型必须被认出来，否则会在压缩触发前超窗（400）
    assert.strictEqual(inferContextWindow("qwen-max"), 32_768);
    assert.strictEqual(inferContextWindow("qwen-plus-character"), 32_768);
    assert.strictEqual(inferContextWindow("qwen-mt-plus"), 16_384);
    assert.strictEqual(inferContextWindow("qwen-flash-character"), 8_192);
  });

  it("Qwen 的同前缀模型不能被更通用的条目盖掉", () => {
    assert.strictEqual(
      matchContextWindowRule("qwen-plus-character")?.prefix,
      "qwen-plus-character",
    );
    assert.strictEqual(
      matchContextWindowRule("qwen-flash-character")?.prefix,
      "qwen-flash-character",
    );
    assert.strictEqual(matchContextWindowRule("qwen-mt-flash")?.prefix, "qwen-mt");
    assert.strictEqual(matchContextWindowRule("qwen3.5-plus")?.prefix, "qwen3.5-plus");
  });

  it("字节跳动火山方舟 Doubao 系列", () => {
    assert.strictEqual(inferContextWindow("doubao-seed-evolving"), 1_000_000);
    assert.strictEqual(inferContextWindow("doubao-seed-2-1-pro-260915"), 1_000_000);
    assert.strictEqual(inferContextWindow("doubao-seed-2-1-lite-260915"), 1_000_000);
    // 2.1 的旧快照与 turbo 是 256K，不能被 1M 的 260915 条目盖住
    assert.strictEqual(inferContextWindow("doubao-seed-2-1-turbo-260628"), 262_144);
    assert.strictEqual(inferContextWindow("doubao-seed-2-1-pro-260628"), 262_144);
    assert.strictEqual(inferContextWindow("doubao-seed-2-0-lite-260428"), 262_144);
    assert.strictEqual(inferContextWindow("doubao-seed-2-0-mini-260428"), 262_144);
    assert.strictEqual(inferContextWindow("doubao-seed-character-260628"), 131_072);
  });

  it("带供应商前缀的百炼 / 方舟模型同样命中", () => {
    assert.strictEqual(inferContextWindow("bailian/qwen3.8-max"), 1_000_000);
    assert.strictEqual(inferContextWindow("bailian/qwen-flash-character"), 8_192);
    assert.strictEqual(
      inferContextWindow("volcengine/doubao-seed-2-1-turbo-260628"),
      262_144,
    );
  });

  it("Anthropic Claude 当前一代", () => {
    assert.strictEqual(inferContextWindow("claude-opus-5-5"), 1_000_000);
    assert.strictEqual(inferContextWindow("claude-sonnet-5-5"), 1_000_000);
    assert.strictEqual(inferContextWindow("claude-fable-5"), 1_000_000);
    assert.strictEqual(inferContextWindow("claude-fable-5-1"), 1_000_000);
    // Haiku 5.5 也是 1M；漏登记会落到 claude 兜底的 200K，等于白白多压几次
    assert.strictEqual(inferContextWindow("claude-haiku-5-5"), 1_000_000);
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
        modelName: "gpt-4o",
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

describe("供应商专属覆盖（同一模型名在不同网关）", () => {
  it("百炼代销的 MiniMax 按 192K 算，不传供应商仍是原厂窗口", () => {
    assert.strictEqual(inferContextWindow("MiniMax-M3", "bailian"), 196_608);
    assert.strictEqual(inferContextWindow("MiniMax-M2.7", "bailian"), 196_608);
    assert.strictEqual(
      inferContextWindow("MiniMax-M2.5-highspeed", "bailian"),
      196_608,
    );
    // 不传供应商 = 原厂口径，改造前后行为一致
    assert.strictEqual(inferContextWindow("MiniMax-M3"), 1_000_000);
    assert.strictEqual(inferContextWindow("MiniMax-M2.7"), 204_800);
    // 其它供应商不参与覆盖，仍按全局表
    assert.strictEqual(inferContextWindow("MiniMax-M3", "minimax-cn"), 1_000_000);
    assert.strictEqual(inferContextWindow("MiniMax-M3", "某个自定义网关"), 1_000_000);
  });

  it("供应商名去空白、大小写不敏感", () => {
    assert.strictEqual(inferContextWindow("MiniMax-M3", "  Bailian "), 196_608);
    assert.strictEqual(inferContextWindow("MiniMax-M3", "BAILIAN"), 196_608);
  });

  it("供应商可以从 供应商/模型名 标签的第一段取", () => {
    assert.strictEqual(inferContextWindow("bailian/MiniMax-M3"), 196_608);
    assert.strictEqual(inferContextWindow("BAILIAN/minimax-m3"), 196_608);
    // 模型名自身可能带 `/`：供应商永远是最前一段
    assert.strictEqual(inferContextWindow("bailian/meta-llama/MiniMax-M3"), 196_608);
    // 显式参数优先于标签
    assert.strictEqual(
      inferContextWindow("bailian/MiniMax-M3", "minimax-cn"),
      1_000_000,
    );
  });

  it("覆盖只作用于登记过的前缀，不吞掉更具体的型号", () => {
    // 百炼的 glm-5.2 仍是 1M；glm-5 / 5.1 的 198K 差异未登记，按全局 200K 取
    assert.strictEqual(inferContextWindow("glm-5.2", "bailian"), 1_000_000);
    assert.strictEqual(inferContextWindow("glm-5.1", "bailian"), 200_000);
    assert.strictEqual(inferContextWindow("MiniMax-M2-her", "bailian"), 65_536);
    // 千问系列没有覆盖，全部走全局表
    assert.strictEqual(inferContextWindow("qwen-max", "bailian"), 32_768);
  });

  it("百炼在售但原厂已下线的型号（mimo-v2.5-pro）", () => {
    assert.strictEqual(inferContextWindow("mimo-v2.5-pro", "bailian"), 1_000_000);
    // 其它入口仍是"认不出"，回落到默认窗口
    assert.strictEqual(inferContextWindow("mimo-v2.5-pro"), DEFAULT_CONTEXT_WINDOW);
    // 覆盖只认完整前缀，不能把同族的其它型号一起带出来
    assert.strictEqual(inferContextWindow("mimo-v2.5", "bailian"), DEFAULT_CONTEXT_WINDOW);
  });

  it("显式配置仍然优先于任何供应商覆盖", () => {
    assert.deepStrictEqual(
      resolveContextWindow({
        configured: 64_000,
        modelName: "MiniMax-M3",
        providerName: "bailian",
      }),
      { window: 64_000, source: "configured" },
    );
  });

  it("resolveContextWindow 透传供应商（显式参数与标签两种来源）", () => {
    assert.deepStrictEqual(
      resolveContextWindow({ modelName: "MiniMax-M3", providerName: "bailian" }),
      { window: 196_608, source: "inferred" },
    );
    assert.deepStrictEqual(resolveContextWindow({ modelName: "bailian/MiniMax-M3" }), {
      window: 196_608,
      source: "inferred",
    });
  });

  it("覆盖条目的前缀不得比它遮蔽的全局条目更短", () => {
    // 反例：`bailian` 下写一条 `glm-5`，会把 `glm-5.2`（1M）一起盖成 200K。
    // 运行时不做守卫（会引入未覆盖分支），用这条数据约束把问题挡在 CI。
    for (const override of PROVIDER_CONTEXT_WINDOW_OVERRIDES) {
      for (const global of CONTEXT_WINDOW_RULES) {
        if (
          global.prefix.startsWith(override.prefix) &&
          global.prefix.length > override.prefix.length
        ) {
          assert.fail(
            `供应商覆盖 ${override.provider}/${override.prefix} 会遮蔽更具体的全局条目 ${global.prefix}`,
          );
        }
      }
    }
  });
});
