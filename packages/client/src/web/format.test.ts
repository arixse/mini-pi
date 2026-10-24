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
  diffStats,
  diffStatsByFile,
  formatClock,
  formatDuration,
  formatBytes,
  formatSessionTime,
  formatTokens,
  parseDiffFiles,
  parseDiffRows,
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

describe("parseDiffRows", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1234567..89abcde 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@ function f() {",
    " context line",
    "-old line",
    "+new line",
    "+another new",
    "\\ No newline at end of file",
  ].join("\n");

  it("文件头归 meta：不数进增删，也不占行号", () => {
    const rows = parseDiffRows(patch);
    assert.equal(rows[0].kind, "meta");
    assert.equal(rows[0].text, "diff --git a/src/a.ts b/src/a.ts");
    assert.equal(rows[0].oldNo, null);
    // --- / +++ 长得像增删行，但不能被统计进去
    assert.equal(rows[2].kind, "meta");
    assert.equal(rows[3].kind, "meta");
  });

  it("hunk 头重置行号起点", () => {
    const rows = parseDiffRows(patch);
    const hunk = rows[4];
    assert.equal(hunk.kind, "hunk");
    assert.equal(hunk.oldNo, null);
    assert.equal(hunk.newNo, null);
  });

  it("增删行各走各的行号，上下文行走双号", () => {
    const rows = parseDiffRows(patch);
    const context = rows[5];
    assert.equal(context.kind, "context");
    assert.equal(context.oldNo, 10);
    assert.equal(context.newNo, 10);
    assert.equal(context.text, "context line");

    const del = rows[6];
    assert.equal(del.kind, "del");
    assert.equal(del.oldNo, 11);
    assert.equal(del.newNo, null);
    assert.equal(del.text, "old line");

    const add = rows[7];
    assert.equal(add.kind, "add");
    assert.equal(add.oldNo, null);
    assert.equal(add.newNo, 11);
    assert.equal(add.text, "new line");

    const add2 = rows[8];
    assert.equal(add2.newNo, 12);
  });

  it("\\ No newline 也是 meta，不推进行号", () => {
    const rows = parseDiffRows(patch);
    const last = rows[rows.length - 1];
    assert.equal(last.kind, "meta");
    assert.equal(last.text, "\\ No newline at end of file");
  });

  it("结尾换行不产生多余的空上下文行", () => {
    const rows = parseDiffRows("@@ -1 +1 @@\n-a\n+b\n");
    assert.equal(rows.length, 3);
  });
});

describe("diffStats", () => {
  it("只数真正的增删行：文件头不算", () => {
    const patch = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-gone",
      "+one",
      "+two",
    ].join("\n");
    assert.deepEqual(diffStats(patch), { additions: 2, deletions: 1 });
  });

  it("空 patch 两个都是 0", () => {
    assert.deepEqual(diffStats(""), { additions: 0, deletions: 0 });
  });
});

describe("diffStatsByFile", () => {
  it("按块统计：每个文件各自 +x −y，口径与 diffStats 一致（文件头不算）", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-gone",
      "+one",
      "+two",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1,2 @@",
      "keep",
      "+added",
    ].join("\n");
    assert.deepEqual(diffStatsByFile(patch), [
      { file: "src/a.ts", additions: 2, deletions: 1 },
      { file: "src/b.ts", additions: 1, deletions: 0 },
    ]);
  });

  it("整文件删除（+++ /dev/null）记到 a 侧路径上", () => {
    const patch = [
      "diff --git a/src/dead.ts b/src/dead.ts",
      "--- a/src/dead.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");
    assert.deepEqual(diffStatsByFile(patch), [{ file: "src/dead.ts", additions: 0, deletions: 1 }]);
  });

  it("路径带空格时 git 的引号写法也能对上", () => {
    const patch = [
      'diff --git "a/my file.ts" "b/my file.ts"',
      '--- "a/my file.ts"',
      '+++ "b/my file.ts"',
      "@@ -1 +1 @@",
      "+x",
    ].join("\n");
    assert.deepEqual(diffStatsByFile(patch), [{ file: "my file.ts", additions: 1, deletions: 0 }]);
  });

  it("空 patch 给空数组", () => {
    assert.deepEqual(diffStatsByFile(""), []);
  });
});

describe("parseDiffFiles", () => {
  const PATCH = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " keep",
    "-gone",
    "+one",
    "+two",
    "@@ -10,2 +11,2 @@",
    " ctx",
    "-old",
    "+new",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1 +1,2 @@",
    "keep",
    "+added",
  ].join("\n");

  it("按文件分组，hunk 头单独一层，增删统计与 diffStatsByFile 一致", () => {
    const blocks = parseDiffFiles(PATCH);
    assert.equal(blocks.length, 2);
    const [a, b] = blocks;
    assert.equal(a?.file, "src/a.ts");
    assert.equal(a?.hunks.length, 2, "两个 @@ 就是两个可折叠的块");
    assert.equal(a?.hunks[0]?.header, "@@ -1,2 +1,3 @@");
    assert.equal(a?.hunks[0]?.rows.length, 4);
    assert.equal(a?.hunks[1]?.rows.length, 3);
    assert.equal(a?.additions, 3);
    assert.equal(a?.deletions, 2);
    assert.equal(b?.file, "src/b.ts");
    assert.deepEqual(
      blocks.map((block) => [block.file, block.additions, block.deletions]),
      diffStatsByFile(PATCH).map((stat) => [stat.file, stat.additions, stat.deletions]),
    );
  });

  it("文件头（diff --git / index / --- / +++）留在 headerRows，不混进 hunk", () => {
    const [first] = parseDiffFiles(PATCH);
    assert.deepEqual(
      first?.headerRows.map((row) => row.text),
      ["diff --git a/src/a.ts b/src/a.ts", "index 111..222 100644", "--- a/src/a.ts", "+++ b/src/a.ts"],
    );
    assert.ok(first?.hunks.every((hunk) => hunk.rows.every((row) => row.kind !== "meta")));
  });

  it("重命名以 +++ 的 b 侧为准（折叠标题要显示最终文件名）", () => {
    const patch = [
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 90%",
      "rename from old/name.ts",
      "rename to new/name.ts",
      "--- a/old/name.ts",
      "+++ b/new/name.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    assert.equal(parseDiffFiles(patch)[0]?.file, "new/name.ts");
  });

  /** 399 之前 patch 被截断时，第一段可能没有 `diff --git`：仍要能折叠 */
  it("从文件中间开始的截断 patch 也有容器，不丢行", () => {
    const blocks = parseDiffFiles(["@@ -1 +1 @@", "-a", "+b"].join("\n"));
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.file, "（未知文件）");
    assert.equal(blocks[0]?.hunks[0]?.header, "@@ -1 +1 @@");
    assert.equal(blocks[0]?.hunks[0]?.rows.length, 2);
  });

  it("hunk 之前的增删行（极少见）归到一个无头 hunk，而不是被丢掉", () => {
    const blocks = parseDiffFiles(["diff --git a/a.ts b/a.ts", "+orphan"].join("\n"));
    assert.equal(blocks[0]?.hunks[0]?.header, null);
    assert.equal(blocks[0]?.hunks[0]?.rows[0]?.text, "orphan");
    assert.equal(blocks[0]?.additions, 1);
  });

  it("CRLF 的 patch 也按行拆（Windows 上 git 输出过 CRLF）", () => {
    const blocks = parseDiffFiles(PATCH.split("\n").join("\r\n"));
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]?.file, "src/a.ts");
    assert.equal(blocks[0]?.additions, 3);
  });

  it("空 patch 给空数组", () => {
    assert.deepEqual(parseDiffFiles(""), []);
  });
});

describe("formatBytes", () => {
  it("按 1024 进位，不是 1000（文件大小与 `ls -l` 对得上）", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1024), "1 KB");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(12_800), "13 KB", "两位以上取整，别写成 12.5 KB");
    assert.equal(formatBytes(1024 * 1024), "1 MB");
    assert.equal(formatBytes(256 * 1024), "256 KB");
  });

  it("非法输入不炸", () => {
    assert.equal(formatBytes(-1), "0 B");
    assert.equal(formatBytes(Number.NaN), "0 B");
    assert.equal(formatBytes(Number.POSITIVE_INFINITY), "0 B");
  });
});

describe("formatClock", () => {
  it("只要时分（气泡里放全日期会把短消息撑成两行）", () => {
    assert.equal(formatClock(new Date(2026, 9, 22, 14, 2).getTime()), "14:02");
    assert.equal(formatClock(new Date(2026, 9, 22, 8, 5).getTime()), "08:05");
  });

  it("0 与非法值给空串：没有时间戳就不画那一行", () => {
    assert.equal(formatClock(0), "");
    assert.equal(formatClock(Number.NaN), "");
  });
});
