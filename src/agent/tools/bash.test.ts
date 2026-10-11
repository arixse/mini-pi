import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_BASH_OUTPUT_CHARS,
  MAX_BASH_TIMEOUT_MS,
  MIN_BASH_TIMEOUT_MS,
  classifyBashFailure,
  resolveBashTimeout,
  taskkillSucceeded,
} from "./bash";
import { createToolRegistry } from "./registry";
import { OUTSIDE_ABSOLUTE_FILE, createTempWorkspace } from "./testWorkspace";

const workspace = createTempWorkspace("tools-bash");
const { testDir } = workspace;

describe("bash 工具（执行、输出上限、超时与终止）", () => {
  beforeEach(() => workspace.reset());
  afterEach(() => workspace.remove());

  describe("bash tool", () => {
    it("should execute command and return output", async () => {
      const registry = createToolRegistry(testDir);
      const result = await registry.execute("bash", {
        command: "echo hello",
      });

      assert.ok(result.content[0].text.includes("hello"));
    });

    it("should reject empty command", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(() => registry.execute("bash", { command: "" }), {
        message: "Command cannot be empty",
      });
    });

    it("should capture stderr", async () => {
      const registry = createToolRegistry(testDir);
      const result = await registry.execute("bash", {
        command: "node -e \"console.error('error msg')\"",
      });

      assert.ok(result.content[0].text.includes("error msg"));
    });

    it("should reject command with absolute path outside workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("bash", { command: `cat ${OUTSIDE_ABSOLUTE_FILE}` }),
        {
          message: /Bash command contains a path outside the workspace/,
        },
      );
    });

    it("should reject command with Unix absolute path", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("bash", { command: "cat /etc/passwd" }),
        {
          message: /Bash command contains a path outside the workspace/,
        },
      );
    });

    it("should reject command with path escape pattern", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("bash", { command: "cat ../../etc/passwd" }),
        {
          message: /Bash command contains a path outside the workspace/,
        },
      );
    });

    it("should reject command with home directory path", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("bash", { command: "cat ~/secret.txt" }),
        {
          message: /home-directory path outside the workspace/,
        },
      );
    });
  });

  describe("bash 输出上限", () => {
    it("超长输出应被截断并标注收窄建议", async () => {
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("bash", {
        command: 'node -e "console.log(\'x\'.repeat(30000))"',
      });
      const text = result.content[0].text;
      const details = result.details as Record<string, unknown>;

      assert.ok(text.length <= MAX_BASH_OUTPUT_CHARS + 300, "返回应被限制在上限附近");
      assert.ok(text.includes("已截断"), "应明确标注被截断");
      assert.ok(text.includes("收窄输出"), "应给出收窄输出的建议");
      assert.strictEqual(details.truncated, true);
      assert.ok(Number(details.outputChars) > MAX_BASH_OUTPUT_CHARS);
    });

    it("普通输出不应被截断", async () => {
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("bash", { command: "echo hello" });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(result.content[0].text.trim(), "hello");
      assert.strictEqual(details.truncated, false);
    });
  });

  describe("bash 超时", () => {
    it("resolveBashTimeout 应夹取到合法区间", () => {
      assert.strictEqual(resolveBashTimeout(undefined), DEFAULT_BASH_TIMEOUT_MS);
      assert.strictEqual(resolveBashTimeout(5_000), 5_000);
      assert.strictEqual(resolveBashTimeout("8000"), 8_000, "数字字符串也接受");
      assert.strictEqual(resolveBashTimeout(10), MIN_BASH_TIMEOUT_MS);
      assert.strictEqual(resolveBashTimeout(10_000_000), MAX_BASH_TIMEOUT_MS);
      assert.strictEqual(resolveBashTimeout("abc"), DEFAULT_BASH_TIMEOUT_MS);
    });

    it("classifyBashFailure 应区分超时、取消与普通失败", () => {
      const timeout = classifyBashFailure(
        { killed: true, signal: "SIGTERM", message: "Command failed: sleep 99" },
        false,
        30_000,
      );
      assert.strictEqual(timeout.timedOut, true);
      assert.strictEqual(timeout.exitCode, 124);
      assert.strictEqual(timeout.errorCode, "ETIMEDOUT");
      assert.ok(timeout.message.includes("命令超时（30000ms）"));
      assert.ok(timeout.message.includes("timeoutMs"), "应告诉模型可以放宽超时");

      const etimedout = classifyBashFailure({ code: "ETIMEDOUT" }, false, 1_000);
      assert.strictEqual(etimedout.timedOut, true);

      const aborted = classifyBashFailure(
        { killed: true, signal: "SIGTERM", message: "aborted" },
        true,
        30_000,
      );
      assert.strictEqual(aborted.aborted, true);
      assert.strictEqual(aborted.timedOut, false, "取消不应被当成超时");

      const failed = classifyBashFailure(
        { code: 2, stderr: "not found" },
        false,
        30_000,
      );
      assert.strictEqual(failed.timedOut, false);
      assert.strictEqual(failed.exitCode, 2);
      assert.strictEqual(failed.message, "not found");
    });

    it("forcedTimeout 应覆盖 error 形态（Windows taskkill 后 error 不可靠）", () => {
      const forced = classifyBashFailure({ code: 1 }, false, 2_000, true);

      assert.strictEqual(forced.timedOut, true);
      assert.strictEqual(forced.exitCode, 124);
      assert.ok(forced.message.includes("命令超时（2000ms）"));
    });

    it("真实超时应被终止并标注 timedOut", async () => {
      // 用独立临时工作区：Windows 上 exec 超时只杀掉 shell，
      // 孙进程可能继续存活并锁住自己作为 cwd 的目录，
      // 若用共享的 testDir 会让后续所有用例的清理连锁失败。
      const timeoutDir = join(
        tmpdir(),
        `mini-pi-timeout-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      mkdirSync(timeoutDir, { recursive: true });

      try {
        const registry = createToolRegistry(timeoutDir);

        const result = await registry.execute("bash", {
          command: 'node -e "setTimeout(() => {}, 3000)"',
          timeoutMs: 1_000,
        });
        const details = result.details as Record<string, unknown>;

        assert.ok(result.content[0].text.includes("命令超时"));
        assert.strictEqual(details.timedOut, true);
        assert.strictEqual(details.exitCode, 124);
        assert.strictEqual(details.timeoutMs, 1_000);
      } finally {
        // 孤儿进程可能仍持有该目录，删不掉就交给系统清理临时目录
        try {
          rmSync(timeoutDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
          // 忽略
        }
      }
    });

    it("正常命令不受超时影响且带 timeoutMs", async () => {
      const registry = createToolRegistry(testDir);

      const result = await registry.execute("bash", { command: "echo ok" });
      const details = result.details as Record<string, unknown>;

      assert.strictEqual(result.content[0].text.trim(), "ok");
      assert.strictEqual(details.timedOut, undefined);
      assert.strictEqual(details.timeoutMs, DEFAULT_BASH_TIMEOUT_MS);
      assert.notStrictEqual(result.isError, true, "成功不应标记为错误");
    });

    it("失败结果必须标记 isError（否则卡片会显示成功）", async () => {
      const registry = createToolRegistry(testDir);

      const timedOut = await registry.execute("bash", {
        command: 'node -e "setTimeout(() => {}, 3000)"',
        timeoutMs: 1_000,
      });
      assert.strictEqual(timedOut.isError, true, "超时应标记为错误");

      const nonZero = await registry.execute("bash", {
        command: 'node -e "process.exit(3)"',
      });
      const details = nonZero.details as Record<string, unknown>;
      assert.strictEqual(nonZero.isError, true, "非零退出应标记为错误");
      assert.strictEqual(details.exitCode, 3);
      assert.strictEqual(details.timedOut, false, "非零退出不是超时");
    });
  });

  describe("taskkillSucceeded（超时终止的成败判定）", () => {
    /**
     * 回归：旧实现调用 `spawnSync("taskkill", ...)` 后无条件 `return`。
     * `spawnSync` 在可执行文件起不来时（受限沙箱报 EBUSY、PATH 缺失等）
     * **不会抛异常**，只把错误塞进返回值，于是终止逻辑被静默跳过、超时失效。
     */
    it("仅在 status === 0 且无 error 时判定为成功", () => {
      assert.strictEqual(taskkillSucceeded({ status: 0 }), true);
      assert.strictEqual(taskkillSucceeded({ status: 0, error: null }), true);
    });

    it("spawn 失败（error 存在 / status 为 null）不得判为成功", () => {
      assert.strictEqual(
        taskkillSucceeded({ error: new Error("spawnSync taskkill EBUSY"), status: null }),
        false,
      );
      assert.strictEqual(taskkillSucceeded({ status: null }), false);
      assert.strictEqual(taskkillSucceeded({}), false, "status 缺省也不应误判");
    });

    it("taskkill 返回非零（进程已不存在等）不得判为成功", () => {
      assert.strictEqual(taskkillSucceeded({ status: 128 }), false);
    });
  });
});
