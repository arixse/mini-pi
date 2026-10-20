import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkBashCommand,
  findCredentialMentions,
  isCredentialFile,
  tokenizeCommand,
  workspaceFileExists,
} from "./workspace";
import { createToolRegistry } from "./registry";
import { IS_WIN32, OUTSIDE_ABSOLUTE_FILE, createTempWorkspace } from "./testWorkspace";

const workspace = createTempWorkspace("tools-workspace");
const { testDir } = workspace;

describe("工作区守卫（路径、凭据与 symlink 逃逸）", () => {
  beforeEach(() => workspace.reset());
  afterEach(() => workspace.remove());

  describe("bash 凭据守卫（凭据类文件）", () => {
    it("findCredentialMentions 应认出命令里的凭据文件", () => {
      assert.deepStrictEqual(findCredentialMentions("cat .env"), [".env"]);
      assert.deepStrictEqual(findCredentialMentions("cat ./config/.env.local"), [".env.local"]);
      assert.deepStrictEqual(findCredentialMentions("cat config/id_rsa"), ["id_rsa"]);
      assert.deepStrictEqual(findCredentialMentions("cat server.pem"), ["server.pem"]);
      assert.deepStrictEqual(findCredentialMentions("cat .git-credentials"), [
        ".git-credentials",
      ]);
      // 参数形式：`--file=.env` 同样是在读凭据
      assert.deepStrictEqual(findCredentialMentions("node app.js --file=.env"), [".env"]);
    });

    it("findCredentialMentions 不应误伤同形名字", () => {
      assert.deepStrictEqual(findCredentialMentions("npm i dotenv"), []);
      assert.deepStrictEqual(findCredentialMentions("cat foo.env"), []);
      // 模板文件不含真实凭据，允许访问
      assert.deepStrictEqual(findCredentialMentions("cat .env.example"), []);
      assert.deepStrictEqual(findCredentialMentions("grep -r process.env src"), []);
    });

    it("bash 命令涉及凭据文件时应被拒绝", () => {
      assert.throws(() => checkBashCommand("cat .env", testDir), /credential file/);
      assert.throws(() => checkBashCommand("cat .env.production", testDir), /credential file/);
      assert.throws(() => checkBashCommand("head -20 id_rsa", testDir), /credential file/);
      assert.throws(() => checkBashCommand("rm .env", testDir), /credential file/);
    });

    it("凭据守卫不得影响普通命令", () => {
      assert.doesNotThrow(() => checkBashCommand("cat .env.example", testDir));
      assert.doesNotThrow(() => checkBashCommand("ls -la", testDir));
    });
  });

  describe("凭据文件名单（isCredentialFile）", () => {
    it("覆盖常见凭据文件与大小写变体", () => {
      const credentials = [
        ".env",
        ".ENV",
        ".env.local",
        ".env.production",
        ".npmrc",
        ".yarnrc",
        ".pypirc",
        ".netrc",
        "_netrc",
        ".git-credentials",
        "credentials",
        "id_rsa",
        "id_ed25519",
        "server.pem",
        "server.key",
        "bundle.p12",
        "app.pfx",
        "app.jks",
        "release.keystore",
        "secrets.yml",
        "secret.json",
      ];

      for (const name of credentials) {
        assert.strictEqual(isCredentialFile(name), true, `${name} 应被判定为凭据文件`);
      }
    });

    it("不误伤模板、普通代码与同形名字", () => {
      const allowed = [
        ".env.example",
        ".env.sample",
        ".env.template",
        "foo.env",
        "dotenv",
        "environment.ts",
        "key.ts",
        "keys.ts",
        "credentials.md",
        "README.md",
      ];

      for (const name of allowed) {
        assert.strictEqual(isCredentialFile(name), false, `${name} 不应被误伤`);
      }
    });

    it("bash 命令里的新名单同样生效（含大小写变体）", () => {
      assert.throws(() => checkBashCommand("cat .ENV", testDir), /credential file/);
      assert.throws(() => checkBashCommand("cat .npmrc", testDir), /credential file/);
      assert.throws(() => checkBashCommand("cat config/credentials", testDir), /credential file/);
      assert.throws(() => checkBashCommand("openssl x509 -in server.key", testDir), /credential file/);
      assert.doesNotThrow(() => checkBashCommand("cat keys.ts", testDir));
    });
  });

  describe("bash 路径守卫（checkBashCommand）", () => {
    it("should reject quoted absolute paths（旧实现可用引号绕过）", () => {
      // 用平台对应的越界绝对路径：POSIX 根路径在 Windows 上会解析成盘符根，
      // 因此两平台都能命中；盘符路径则只有 Windows 认（见下一条）。
      assert.throws(
        () => checkBashCommand(`cat "${OUTSIDE_ABSOLUTE_FILE}"`, testDir),
        /path outside the workspace/,
      );
      assert.throws(
        () => checkBashCommand("cat '/etc/passwd'", testDir),
        /path outside the workspace/,
      );
    });

    it("should reject absolute paths embedded in strings", () => {
      assert.throws(
        () =>
          checkBashCommand(
            `node -e "require('fs').readFileSync('${OUTSIDE_ABSOLUTE_FILE}')"`,
            testDir,
          ),
        /path outside the workspace/,
      );
    });

    it("should reject quoted relative escapes", () => {
      assert.throws(
        () => checkBashCommand('cat "../outside.txt"', testDir),
        /path outside the workspace/,
      );
      assert.throws(
        () => checkBashCommand("cat '../etc/passwd'", testDir),
        /path outside the workspace/,
      );
    });

    /**
     * 盘符与反斜杠是 Windows 独有的路径语法：在 POSIX 上 `D:\secret.txt`
     * 与 `..\..\secret.txt` 都只是「名字里含反斜杠的普通文件」，位于工作区内，
     * 守卫放行是**正确**的（Linux 允许反斜杠作为文件名字符）。
     * 因此这些形态只在 Windows 上断言，CI（ubuntu）跳过。
     */
    it("should reject Windows drive paths", { skip: !IS_WIN32 }, () => {
      assert.throws(
        () => checkBashCommand('cat "D:\\secret.txt"', testDir),
        /path outside the workspace/,
      );
      assert.throws(
        () =>
          checkBashCommand(
            'node -e "require(\'fs\').readFileSync(\'D:/secret.txt\')"',
            testDir,
          ),
        /path outside the workspace/,
      );
    });

    it("should reject Windows backslash traversals", { skip: !IS_WIN32 }, () => {
      assert.throws(
        () => checkBashCommand('cat "..\\..\\secret.txt"', testDir),
        /path outside the workspace/,
      );
    });

    it("should reject home-directory references", () => {
      assert.throws(
        () => checkBashCommand("cat ~/secret.txt", testDir),
        /home-directory path outside the workspace/,
      );
      assert.throws(
        () => checkBashCommand("cat %USERPROFILE%\\secret.txt", testDir),
        /home-directory variable/,
      );
      assert.throws(
        () => checkBashCommand("cat $HOME/secret.txt", testDir),
        /home-directory variable/,
      );
    });

    it("should allow commands that stay inside the workspace", () => {
      assert.doesNotThrow(() => checkBashCommand("echo hello", testDir));
      assert.doesNotThrow(() => checkBashCommand("git status", testDir));
      // `..` 仍在工作区内（s/a/../b -> s/b），不应误报
      assert.doesNotThrow(() => checkBashCommand("sed s/a/../b/ file.txt", testDir));
      // `a..b` 不是路径段，不应误报
      assert.doesNotThrow(() => checkBashCommand('grep "a..b" file.txt', testDir));
      // URL 内的 `//` 不是 POSIX 根路径
      assert.doesNotThrow(() =>
        checkBashCommand("curl https://api.example.com/v1/models", testDir),
      );
      assert.doesNotThrow(() => checkBashCommand("cat src/index.ts", testDir));
    });

    it("should tolerate Windows-style switches on Windows only", () => {
      if (process.platform === "win32") {
        assert.doesNotThrow(() => checkBashCommand("dir /b", testDir));
      } else {
        assert.throws(
          () => checkBashCommand("dir /b", testDir),
          /path outside the workspace/,
        );
      }
    });

    it("should tokenize quoted arguments without leaking quotes", () => {
      assert.deepStrictEqual(tokenizeCommand('cat "a b" c'), [
        "cat",
        "a b",
        "c",
      ]);
      assert.deepStrictEqual(tokenizeCommand("echo 'x|y' | grep x"), [
        "echo",
        "x|y",
        "|",
        "grep",
        "x",
      ]);
    });
  });

  describe("真实路径校验（symlink 逃逸）", () => {
    let outsideDir: string;
    let linkPath: string;

    beforeEach(() => {
      outsideDir = join(
        tmpdir(),
        `mini-pi-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      );
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "secret.txt"), "top secret");

      linkPath = join(testDir, "link-outside");
      // Windows 上目录 junction 不需要管理员权限；POSIX 用普通目录符号链接
      symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    });

    afterEach(() => {
      if (existsSync(outsideDir)) {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("should reject reading through a symlink pointing outside the workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("read_file", { path: "link-outside/secret.txt" }),
        { message: /Path escapes workspace/ },
      );
    });

    it("should reject writing through a symlink pointing outside the workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () =>
          registry.execute("write_file", {
            path: "link-outside/planted.txt",
            content: "escaped",
          }),
        { message: /Path escapes workspace/ },
      );
      assert.ok(!existsSync(join(outsideDir, "planted.txt")));
    });

    it("should reject listing through a symlink pointing outside the workspace", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(
        () => registry.execute("list_files", { path: "link-outside" }),
        { message: /Path escapes workspace/ },
      );
    });

    it("遍历时跳过指向工作区外的符号链接，并如实报告数量", async () => {
      // 入口路径有守卫，但遍历途中遇到的链接需要单独判定：
      // 否则从工作区根发起 list_files / grep 就能穿过链接读到外部文件
      writeFileSync(join(testDir, "keep.txt"), "top secret\n");
      const registry = createToolRegistry(testDir);

      const listed = await registry.execute("list_files", { path: "." });
      const listDetails = listed.details as Record<string, unknown>;
      assert.deepStrictEqual(listDetails.entries, ["keep.txt"]);
      assert.strictEqual(listDetails.skippedExternalLinks, 1);
      assert.ok(listed.content[0].text.includes("指向工作区之外"));

      const grepped = await registry.execute("grep", { pattern: "top secret" });
      const grepDetails = grepped.details as Record<string, unknown>;
      assert.deepStrictEqual(grepDetails.matches, [
        { path: "keep.txt", line: 1, text: "top secret" },
      ]);
      assert.strictEqual(grepDetails.skippedExternalLinks, 1);
    });

    it("should allow names that merely start with dots", async () => {
      // 回归：旧实现用 rel.startsWith("..") 判断逃逸，会误伤 ..name 这类合法名字
      writeFileSync(join(testDir, "..config.json"), '{"ok":true}');
      const registry = createToolRegistry(testDir);
      const result = await registry.execute("read_file", { path: "..config.json" });
      assert.ok(result.content[0].text.includes("ok"));
    });

    it("should reject an empty path", async () => {
      const registry = createToolRegistry(testDir);
      await assert.rejects(() => registry.execute("read_file", { path: "" }), {
        message: /Path cannot be empty/,
      });
    });
  });
});

describe("workspaceFileExists（审批展示里的覆盖判断）", () => {
  beforeEach(() => workspace.reset());
  afterEach(() => workspace.remove());

  it("只在工作区内且真实存在时为 true", () => {
    writeFileSync(join(testDir, "a.txt"), "x");
    assert.strictEqual(workspaceFileExists(testDir, "a.txt"), true);
    assert.strictEqual(workspaceFileExists(testDir, "b.txt"), false);
  });

  it("逃逸出工作区的路径一律按「不存在」处理", () => {
    // 只影响展示（要不要标"覆盖"），真正写入时的守卫在 resolveInsideWorkspace
    assert.strictEqual(workspaceFileExists(testDir, "../outside.txt"), false);
    assert.strictEqual(workspaceFileExists(testDir, OUTSIDE_ABSOLUTE_FILE), false);
  });

  it("空路径与纯空白不算文件", () => {
    assert.strictEqual(workspaceFileExists(testDir, ""), false);
    assert.strictEqual(workspaceFileExists(testDir, "   "), false);
  });

  it("名字以两个点开头但仍在工作区内的文件，不该被当成逃逸", () => {
    // 旧实现用 startsWith("..") 判定逃逸，会把 "..foo" 误判成越界
    writeFileSync(join(testDir, "..foo"), "x");
    assert.strictEqual(workspaceFileExists(testDir, "..foo"), true);
  });
});
