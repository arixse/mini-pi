/**
 * "记住的工作区"那份文件的读写。
 *
 * 多工作区之后它记的是一组：`{ roots: [...], active }`。三种坏法都会让
 * 用户**每次启动都被再问一遍**：写了一半（崩溃在写盘途中）、读出来不是
 * 字符串、文件被改成了别的形状。因此这里逐条钉住：没有、有、坏、
 * 旧格式迁移，分别是四个不同的答案。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  WORKSPACE_MEMORY_FILE,
  fileWorkspaceMemory,
  forgetWorkspace,
  nullWorkspaceMemory,
  readRememberedWorkspace,
  readRememberedWorkspaces,
  rememberWorkspace,
  workspaceMemoryPath,
} from "./workspaceMemory";

/** 一个临时目录里的记忆文件路径；各用例自己写内容 */
function tempMemory(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "minipi-memory-"));
  return {
    file: join(dir, WORKSPACE_MEMORY_FILE),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("readRememberedWorkspaces", () => {
  it("没有文件就是没有（第一次启动的形状）", async () => {
    const memory = tempMemory();
    try {
      assert.strictEqual(await readRememberedWorkspaces(memory.file), null);
    } finally {
      memory.cleanup();
    }
  });

  it("写进去什么读出来什么", async () => {
    const memory = tempMemory();
    try {
      await rememberWorkspace("D:\\projects\\mini-pi", memory.file);
      await rememberWorkspace("D:\\other", memory.file);
      const remembered = await readRememberedWorkspaces(memory.file);
      assert.ok(remembered);
      assert.deepStrictEqual(remembered.roots, ["D:\\projects\\mini-pi", "D:\\other"]);
      assert.strictEqual(remembered.active, "D:\\other");
    } finally {
      memory.cleanup();
    }
  });

  it("并发 remember 不会互相覆盖列表（读改写必须串行）", async () => {
    const memory = tempMemory();
    try {
      // 三个调用几乎同时读到"没有文件"，各自写出只含自己的列表——
      // 后写者会把前两者整个覆盖，"刚打开的工作区下次启动不见了"。
      await Promise.all([
        rememberWorkspace("D:\\projects", memory.file),
        rememberWorkspace("D:\\other", memory.file),
        rememberWorkspace("D:\\third", memory.file),
      ]);

      const remembered = await readRememberedWorkspaces(memory.file);
      assert.ok(remembered);
      assert.deepStrictEqual(remembered.roots, ["D:\\projects", "D:\\other", "D:\\third"]);
      assert.strictEqual(remembered.active, "D:\\third");
      assert.deepStrictEqual(
        readdirSync(dirname(memory.file)).filter((name) => name.endsWith(".tmp")),
        [],
        "并发写入不能留下临时文件",
      );
    } finally {
      memory.cleanup();
    }
  });

  it("并发的 remember 与 forget 串行执行，不产生残影", async () => {
    const memory = tempMemory();
    try {
      await rememberWorkspace("D:\\a", memory.file);
      await rememberWorkspace("D:\\b", memory.file);

      await Promise.all([
        rememberWorkspace("D:\\c", memory.file),
        forgetWorkspace("D:\\a", memory.file),
      ]);

      const remembered = await readRememberedWorkspaces(memory.file);
      assert.ok(remembered);
      assert.deepStrictEqual(remembered.roots, ["D:\\b", "D:\\c"]);
      assert.strictEqual(remembered.active, "D:\\c");
    } finally {
      memory.cleanup();
    }
  });

  it("旧格式 { workspace } 当场迁移成单元素列表", async () => {
    const memory = tempMemory();
    try {
      writeFileSync(memory.file, JSON.stringify({ workspace: "D:\\old" }, null, 2), "utf8");
      const remembered = await readRememberedWorkspaces(memory.file);
      assert.ok(remembered);
      assert.deepStrictEqual(remembered.roots, ["D:\\old"]);
      assert.strictEqual(remembered.active, "D:\\old");
      // 兼容入口：桌面壳拿"上次活动的那个"当初始根
      assert.strictEqual(await readRememberedWorkspace(memory.file), "D:\\old");
    } finally {
      memory.cleanup();
    }
  });

  it("JSON 坏了返回 null：下次再问一次，而不是起在一个错路径上", async () => {
    const memory = tempMemory();
    try {
      writeFileSync(memory.file, "{ 这不是 json", "utf8");
      assert.strictEqual(await readRememberedWorkspaces(memory.file), null);
    } finally {
      memory.cleanup();
    }
  });

  it("顶层不是对象、roots 不是数组、一条有效路径都没有，都算没有", async () => {
    const memory = tempMemory();
    try {
      const bad = [
        "[]",
        "null",
        '"a-string"',
        "{}",
        '{"roots": 42}',
        '{"roots": "a"}',
        '{"roots": []}',
        '{"roots": ["", "   "]}',
        '{"workspace": 42}',
        '{"workspace": ""}',
      ];
      for (const content of bad) {
        writeFileSync(memory.file, content, "utf8");
        assert.strictEqual(await readRememberedWorkspaces(memory.file), null, content);
      }
    } finally {
      memory.cleanup();
    }
  });

  it("roots 里混进非字符串时滤掉，剩多少算多少", async () => {
    const memory = tempMemory();
    try {
      writeFileSync(memory.file, '{"roots": ["D:\\\\keep", 7, null, ""]}', "utf8");
      const remembered = await readRememberedWorkspaces(memory.file);
      assert.ok(remembered);
      assert.deepStrictEqual(remembered.roots, ["D:\\keep"]);
      assert.strictEqual(remembered.active, "D:\\keep");
    } finally {
      memory.cleanup();
    }
  });

  it("active 不在 roots 里时回落到第一个，而不是信文件里的悬空值", async () => {
    const memory = tempMemory();
    try {
      writeFileSync(
        memory.file,
        '{"roots": ["D:\\\\a", "D:\\\\b"], "active": "D:\\\\gone"}',
        "utf8",
      );
      const remembered = await readRememberedWorkspaces(memory.file);
      assert.ok(remembered);
      assert.strictEqual(remembered.active, "D:\\a");
    } finally {
      memory.cleanup();
    }
  });
});

describe("rememberWorkspace", () => {
  it("目录不存在时连目录一起建（~/.mini-pi 可能还没建过）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minipi-memory-nested-"));
    try {
      const file = join(dir, "nested", "deep", WORKSPACE_MEMORY_FILE);
      await rememberWorkspace("D:\\projects", file);
      assert.ok(existsSync(file));
      assert.strictEqual(await readRememberedWorkspace(file), "D:\\projects");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("重复记是挪 active，不是清掉别的条目（记一组，不是记一个）", async () => {
    const memory = tempMemory();
    try {
      await rememberWorkspace("D:\\first", memory.file);
      await rememberWorkspace("D:\\second", memory.file);
      await rememberWorkspace("D:\\first", memory.file);
      const remembered = await readRememberedWorkspaces(memory.file);
      assert.ok(remembered);
      assert.deepStrictEqual(remembered.roots, ["D:\\first", "D:\\second"]);
      assert.strictEqual(remembered.active, "D:\\first");
    } finally {
      memory.cleanup();
    }
  });

  it("临时文件不会留在目录里（rename 成功即清理）", async () => {
    const memory = tempMemory();
    try {
      await rememberWorkspace("D:\\projects", memory.file);
      assert.strictEqual(await readRememberedWorkspace(memory.file), "D:\\projects");
      // 只应有记忆文件本身：临时名带 pid，rename 之后必须消失
      assert.deepStrictEqual(readdirSync(join(memory.file, "..")), [WORKSPACE_MEMORY_FILE]);
    } finally {
      memory.cleanup();
    }
  });
});

describe("forgetWorkspace", () => {
  it("摘掉一条，剩下的留着；摘的是 active 就挪到剩下的第一个", async () => {
    const memory = tempMemory();
    try {
      await rememberWorkspace("D:\\a", memory.file);
      await rememberWorkspace("D:\\b", memory.file);
      await forgetWorkspace("D:\\b", memory.file);
      const remembered = await readRememberedWorkspaces(memory.file);
      assert.ok(remembered);
      assert.deepStrictEqual(remembered.roots, ["D:\\a"]);
      assert.strictEqual(remembered.active, "D:\\a");
    } finally {
      memory.cleanup();
    }
  });

  it("摘到最后一条为空：文件还在（空列表），读出来就是没有", async () => {
    const memory = tempMemory();
    try {
      await rememberWorkspace("D:\\only", memory.file);
      await forgetWorkspace("D:\\only", memory.file);
      assert.strictEqual(await readRememberedWorkspaces(memory.file), null);
      assert.ok(existsSync(memory.file), "空列表写回文件，不悄悄删用户目录里的东西");
    } finally {
      memory.cleanup();
    }
  });

  it("没有记忆文件时 forget 是 no-op，不凭空造文件", async () => {
    const memory = tempMemory();
    try {
      await forgetWorkspace("D:\\never-was", memory.file);
      assert.strictEqual(existsSync(memory.file), false);
    } finally {
      memory.cleanup();
    }
  });
});

describe("readRememberedWorkspace", () => {
  /** 桌面壳的初始根只认 `active` 这一项；列表恢复归 bootAppServer 管 */
  it("回答的是列表里的 active", async () => {
    const memory = tempMemory();
    try {
      await rememberWorkspace("D:\\a", memory.file);
      await rememberWorkspace("D:\\b", memory.file);
      assert.strictEqual(await readRememberedWorkspace(memory.file), "D:\\b");
    } finally {
      memory.cleanup();
    }
  });
});

describe("workspaceMemoryPath", () => {
  it("落在 ~/.mini-pi 下，与 auth.json / settings.json 同目录", () => {
    const path = workspaceMemoryPath();
    assert.ok(path.endsWith(join(".mini-pi", WORKSPACE_MEMORY_FILE)), path);
  });
});

describe("nullWorkspaceMemory", () => {
  /**
   * 默认实现必须是"什么都不做"：构造一个服务不该顺带往用户家目录写文件。
   * 这条断言守着的是那个默认值的语义——它看起来什么都没做，但那正是重点。
   */
  it("读是 null，写与摘都不抛", async () => {
    assert.strictEqual(await nullWorkspaceMemory.list(), null);
    await assert.doesNotReject(() => nullWorkspaceMemory.remember("D:\\anywhere"));
    await assert.doesNotReject(() => nullWorkspaceMemory.forget("D:\\anywhere"));
  });
});

describe("fileWorkspaceMemory", () => {
  /**
   * 真实入口（serve / Electron 主进程 / desktop）接的就是这个实例。
   * 它看着只是转调文件函数，但"入口确实接上了"这件事只有在这里才被
   * 测到——转调断了的表现是桌面壳每次启动都重新问。
   */
  it("list / remember / forget 转调同一份文件（默认位置）", async () => {
    const memory = tempMemory();
    const savedHome = process.env.USERPROFILE;
    const savedPosixHome = process.env.HOME;
    const savedDrive = process.env.HOMEDRIVE;
    const savedPath = process.env.HOMEPATH;
    try {
      // homedir() 在 Windows 上认 USERPROFILE、在 POSIX 上认 HOME：
      // 两个都要指到临时目录。只改 USERPROFILE 的话，Linux/macOS 上
      // 记忆文件会写进真家目录，而断言照着临时路径去找——必然对不上。
      const fakeHome = join(memory.file, "..");
      process.env.USERPROFILE = fakeHome;
      process.env.HOME = fakeHome;
      delete process.env.HOMEDRIVE;
      delete process.env.HOMEPATH;

      await fileWorkspaceMemory.remember("D:\\projects");
      const expected = join(fakeHome, ".mini-pi", WORKSPACE_MEMORY_FILE);
      let listed = await fileWorkspaceMemory.list();
      assert.ok(listed);
      assert.deepStrictEqual(listed.roots, ["D:\\projects"]);

      await fileWorkspaceMemory.remember("D:\\other");
      await fileWorkspaceMemory.forget("D:\\projects");
      listed = await fileWorkspaceMemory.list();
      assert.ok(listed);
      assert.deepStrictEqual(listed.roots, ["D:\\other"]);
      assert.strictEqual(await readRememberedWorkspace(expected), "D:\\other");
    } finally {
      if (savedHome === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = savedHome;
      }
      if (savedPosixHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = savedPosixHome;
      }
      if (savedDrive !== undefined) {
        process.env.HOMEDRIVE = savedDrive;
      }
      if (savedPath !== undefined) {
        process.env.HOMEPATH = savedPath;
      }
      memory.cleanup();
    }
  });
});
