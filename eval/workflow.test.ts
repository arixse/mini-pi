/**
 * 评测 workflow 的静态约束。
 *
 * 这里断言的不是 YAML 结构（引一个解析器只为几行断言不划算），而是几条
 * **缺了就会出事**的接线：没密钥要跳过而不是失败、PR 要打标签才跑、
 * 失败也要留产物、凭据只能写进临时 home，以及本地评测跑的不是过期 bundle。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOW = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "eval.yml"),
  "utf8",
);

describe("eval workflow", () => {
  it("三种触发方式齐全：手动、每晚、PR 打 eval 标签", () => {
    assert.match(WORKFLOW, /workflow_dispatch:/);
    assert.match(WORKFLOW, /schedule:/);
    assert.match(WORKFLOW, /pull_request:/);
    assert.match(WORKFLOW, /contains\(github\.event\.pull_request\.labels\.\*\.name, 'eval'\)/);
  });

  it("默认 smoke，nightly 跑 regression", () => {
    assert.match(WORKFLOW, /github\.event_name == 'schedule' && 'regression' \|\| 'smoke'/);
  });

  it("没有密钥时给 notice 而不是让 job 变红", () => {
    assert.match(WORKFLOW, /::notice title=评测跳过/);
    assert.match(WORKFLOW, /if: env\.MINI_PI_AUTH_JSON == '' \|\| env\.MINI_PI_EVAL_MODEL == ''/);
  });

  it("凭据只写进临时 home，且跑的就是仓库内 CLI", () => {
    assert.match(WORKFLOW, /printf '%s' "\$MINI_PI_AUTH_JSON" > "\$HOME\/\.mini-pi\/auth\.json"/);
    assert.match(WORKFLOW, /pnpm eval --suite "\$EVAL_SUITE"/);
  });

  it("无论成败都上传产物（transcript 与 grade.log 是排查入口）", () => {
    assert.match(WORKFLOW, /actions\/upload-artifact@v4/);
    assert.match(WORKFLOW, /if: always\(\)/);
    assert.match(WORKFLOW, /path: eval\/\.runs/);
  });

  it("pnpm eval 先重建 CLI，避免本地评测跑在过期 bundle 上", () => {
    // 2026-10-30 的 guard-danger 失败就是踩了这个坑：bin/mini-pi-cli.cjs 是
    // .gitignore 的产物，`tsx eval/run.ts` 不会重建它。结果评测跑的是 10-20 的
    // bundle——连 --model / --home 都没解析，参数被拼进了 prompt。CI 靠 install
    // 的 prepare 侥幸躲过，本地却没有等价保障，所以把构建写进 eval 脚本本身。
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.strictEqual(pkg.scripts.eval, "pnpm build:cli && tsx eval/run.ts");
  });
});
