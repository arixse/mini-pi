import { describe, it } from "node:test";
import assert from "node:assert";
import {
  VOLCENGINE_DEPRECATION_BATCHES,
  filterRetiredVolcengineModels,
  getVolcengineRetirement,
  isVolcengineModelRetired,
  normalizeVolcengineModelId,
} from "./volcengine-retired";

/** 固定"现在"，避免测试随真实时钟漂移 */
const NOW = new Date("2026-10-26T12:00:00+08:00");

describe("normalizeVolcengineModelId", () => {
  it("统一大小写、首尾空白与官方表格里的分隔符", () => {
    assert.strictEqual(
      normalizeVolcengineModelId("  DeepSeek-R1-Distill-Qwen-32B-250120  "),
      "deepseek-r1-distill-qwen-32b-250120",
    );
    assert.strictEqual(
      normalizeVolcengineModelId("doubao-pro-32k/character-241215"),
      "doubao-pro-32k-character-241215",
    );
    assert.strictEqual(
      normalizeVolcengineModelId("doubao-1.5-thinking-pro-m-250415"),
      "doubao-1-5-thinking-pro-m-250415",
    );
  });

  it("幂等：归一化过的 ID 再归一化不变化", () => {
    for (const batch of VOLCENGINE_DEPRECATION_BATCHES) {
      for (const model of batch.models) {
        const once = normalizeVolcengineModelId(model);
        assert.strictEqual(normalizeVolcengineModelId(once), once, model);
      }
    }
  });

  it("不误伤推理接入点与普通 ID", () => {
    assert.strictEqual(normalizeVolcengineModelId("ep-20261025"), "ep-20261025");
    assert.strictEqual(normalizeVolcengineModelId(""), "");
  });
});

describe("getVolcengineRetirement", () => {
  it("返回已知型号的批次与 EOS", () => {
    assert.deepStrictEqual(getVolcengineRetirement("doubao-lite-128k-240428"), {
      batch: "2025 第二批",
      eos: "2025-05-28",
    });
  });

  it("大小写与分隔符不同也能命中", () => {
    for (const model of [
      "DeepSeek-r1-distill-qwen-32b-250120",
      "deepseek-R1-DISTILL-QWEN-32B-250120",
      "doubao-1.5-thinking-pro-m-250415",
      "doubao-1-5-thinking-pro-m-250415",
    ]) {
      assert.ok(getVolcengineRetirement(model), `${model} 应命中下线清单`);
    }
  });

  it("同一型号出现在多批公告里时取最早的 EOS", () => {
    // 2024 第一批（2025-04-15）与 2025 第二批（2025-05-28）都登记了它
    assert.deepStrictEqual(getVolcengineRetirement("doubao-lite-32k-240428"), {
      batch: "2024 第一批",
      eos: "2025-04-15",
    });
  });

  it("未知型号、接入点与空串不命中", () => {
    for (const model of [
      "doubao-seed-evolving",
      "doubao-seed-2-1-pro-260915",
      "ep-20261025",
      "my-private-deployment",
      "",
    ]) {
      assert.strictEqual(getVolcengineRetirement(model), undefined, model);
    }
  });
});

describe("isVolcengineModelRetired", () => {
  it("EOS 早已过去的型号判定为已下线", () => {
    assert.ok(isVolcengineModelRetired("doubao-lite-128k-240428", NOW));
    assert.ok(isVolcengineModelRetired("deepseek-v3-1-250821", NOW));
    assert.ok(isVolcengineModelRetired("doubao-seed-1-6-250615", NOW));
  });

  it("EOS 当天 UTC+8 零点起生效", () => {
    const model = "doubao-seed-2-0-lite-260215"; // EOS 2026-10-22
    assert.strictEqual(
      isVolcengineModelRetired(model, new Date("2026-10-21T23:59:59+08:00")),
      false,
    );
    assert.strictEqual(
      isVolcengineModelRetired(model, new Date("2026-10-22T00:00:00+08:00")),
      true,
    );
  });

  it("尚未到 EOS 的公告型号不提前隐藏（账号仍可调用）", () => {
    const model = "doubao-seed-2-0-pro-260215"; // EOS 2026-11-24
    assert.strictEqual(isVolcengineModelRetired(model, NOW), false);
    assert.strictEqual(
      isVolcengineModelRetired(model, new Date("2026-11-24T00:00:00+08:00")),
      true,
    );
  });

  it("未知型号与接入点永远不判定为已下线", () => {
    assert.strictEqual(isVolcengineModelRetired("ep-20261025", NOW), false);
    assert.strictEqual(isVolcengineModelRetired("brand-new-model", NOW), false);
  });
});

describe("filterRetiredVolcengineModels", () => {
  it("过滤已下线型号，保留顺序与在售 / 未知型号", () => {
    const input = [
      "doubao-lite-128k-240428",
      "doubao-seed-2-1-turbo-260628",
      "ep-20261025",
      "doubao-seed-1-6-250615",
      "my-private-deployment",
    ];
    const before = [...input];

    assert.deepStrictEqual(filterRetiredVolcengineModels(input, NOW), [
      "doubao-seed-2-1-turbo-260628",
      "ep-20261025",
      "my-private-deployment",
    ]);
    assert.deepStrictEqual(input, before, "不能改动调用方的数组");
  });

  it("空列表与全下线列表", () => {
    assert.deepStrictEqual(filterRetiredVolcengineModels([], NOW), []);
    assert.deepStrictEqual(
      filterRetiredVolcengineModels(
        ["doubao-lite-128k-240428", "Moonshot-v1-8k"],
        NOW,
      ),
      [],
    );
  });

  it("只按精确 ID 过滤，不做前缀 / 模糊匹配", () => {
    // 不能因为清单里有 doubao-lite-128k-240428 就把同前缀的其它型号删掉
    assert.deepStrictEqual(
      filterRetiredVolcengineModels(
        ["doubao-lite-128k", "doubao-lite-128k-240429", "doubao-lite-128k-240428"],
        NOW,
      ),
      ["doubao-lite-128k", "doubao-lite-128k-240429"],
    );
  });
});

describe("下线清单数据完整性", () => {
  it("每批都有模型，EOS 都是合法的 UTC+8 日期", () => {
    assert.ok(VOLCENGINE_DEPRECATION_BATCHES.length >= 10);
    for (const batch of VOLCENGINE_DEPRECATION_BATCHES) {
      assert.ok(batch.batch.length > 0, "批次名不能为空");
      assert.ok(batch.models.length > 0, `${batch.batch} 没有模型`);
      assert.match(batch.eos, /^\d{4}-\d{2}-\d{2}$/, `${batch.batch} 的 EOS 格式不对`);
      assert.ok(
        Number.isFinite(Date.parse(`${batch.eos}T00:00:00+08:00`)),
        `${batch.batch} 的 EOS 不是合法日期：${batch.eos}`,
      );
    }
  });

  it("模型 ID 不含空白 / 中文备注，且同一批内没有重复", () => {
    for (const batch of VOLCENGINE_DEPRECATION_BATCHES) {
      const seen = new Set<string>();
      for (const model of batch.models) {
        assert.ok(!/\s/.test(model), `${batch.batch} 的 ${model} 含空白`);
        assert.ok(/^[\x21-\x7e]+$/.test(model), `${batch.batch} 的 ${model} 不是 ASCII ID`);
        const key = normalizeVolcengineModelId(model);
        assert.ok(!seen.has(key), `${batch.batch} 重复登记了 ${model}`);
        seen.add(key);
      }
    }
  });

  it("每批至少有一条记录会在 EOS 之后被判定为下线", () => {
    for (const batch of VOLCENGINE_DEPRECATION_BATCHES) {
      const afterEos = new Date(`${batch.eos}T00:00:00+08:00`);
      for (const model of batch.models) {
        assert.ok(
          isVolcengineModelRetired(model, afterEos),
          `${batch.batch} 的 ${model} 在 EOS 后仍未被判定下线`,
        );
      }
    }
  });
});
