/**
 * "记住的工作区"那一行文件的读写。
 *
 * 它只有一行路径，但三种坏法都会让用户**每次启动都被再问一遍**：
 * 写了一半（崩溃在写盘途中）、读出来不是字符串、文件被改成了别的形状。
 * 因此这里逐条钉住：没有、有、坏，分别是三个不同的答案。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKSPACE_MEMORY_FILE,
  fileWorkspaceMemory,
  nullWorkspaceMemory,
  readRememberedWorkspace,
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

describe("readRememberedWorkspace", () => {
  it("没有文件就是没有（第一次启动的形状）", async () => {
    const memory = tempMemory();
    try {
      assert.strictEqual(await readRememberedWorkspace(memory.file), null);
    } finally {
      memory.cleanup();
    }
  });

  it("写进去什么读出来什么", async () => {
    const memory = tempMemory();
    try {
      await rememberWorkspace("D:\\projects\\mini-pi", memory.file);
      assert.strictEqual(await readRememberedWorkspace(memory.file), "D:\\projects\\mini-pi");
    } finally {
      memory.cleanup();
    }
  });

  it("JSON 坏了返回 null：下次再问一次，而不是起在一个错路径上", async () => {
    const memory = tempMemory();
    try {
      writeFileSync(memory.file, "{ 这不是 json", "utf8");
      assert.strictEqual(await readRememberedWorkspace(memory.file), null);
    } finally {
      memory.cleanup();
    }
  });

  it("顶层不是对象、字段不是字符串，都算没有", async () => {
    const memory = tempMemory();
    try {
      for (const content of ["[]", "null", '"a-string"', "{}", '{"workspace": 42}', '{"workspace": ""}']) {
        writeFileSync(memory.file, content, "utf8");
        assert.strictEqual(await readRememberedWorkspace(memory.file), null, content);
      }
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

  it("重复记是覆盖，不是追加（文件里始终只有一个路径）", async () => {
    const memory = tempMemory();
    try {
      await rememberWorkspace("D:\\first", memory.file);
      await rememberWorkspace("D:\\second", memory.file);
      const raw = readFileSync(memory.file, "utf8");
      assert.ok(!raw.includes("first"), raw);
      assert.strictEqual(await readRememberedWorkspace(memory.file), "D:\\second");
    } finally {
      memory.cleanup();
    }
  });

  it("临时文件不会留在目录里（ rename 成功即清理）", async () => {
    const memory = tempMemory();
    try {
      await rememberWorkspace("D:\\projects", memory.file);
      assert.strictEqual(await readRememberedWorkspace(memory.file), "D:\\projects");
      // 只应有记忆文件本身：临时名带 pid， rename 之后必须消失
      const { readdirSync } = await import("node:fs");
      assert.deepStrictEqual(readdirSync(join(memory.file, "..")), [WORKSPACE_MEMORY_FILE]);
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
   * 默认实现必须是"不记"：构造一个服务不该顺带往用户家目录写文件。
   * 这条断言守着的是那个默认值的语义——它看起来什么都没做，但那正是重点。
   */
  it("什么都不做，也不抛", async () => {
    await assert.doesNotReject(() => nullWorkspaceMemory.remember("D:\\anywhere"));
  });
});

describe("fileWorkspaceMemory", () => {
  /**
   * 真实入口（serve / Electron 主进程 / desktop）接的就是这个实例。
   * 它看着只是转调 `rememberWorkspace`，但"入口确实接上了"这件事
   * 只有在这里才被测到——转调断了的表现是桌面壳每次启动都重新问。
   */
  it("remember 转调 rememberWorkspace（默认位置）", async () => {
    const memory = tempMemory();
    const savedHome = process.env.USERPROFILE;
    const savedDrive = process.env.HOMEDRIVE;
    const savedPath = process.env.HOMEPATH;
    try {
      // homedir() 在 Windows 上认 USERPROFILE：指到临时目录，免得写进真家目录
      const fakeHome = join(memory.file, "..");
      process.env.USERPROFILE = fakeHome;
      delete process.env.HOMEDRIVE;
      delete process.env.HOMEPATH;

      await fileWorkspaceMemory.remember("D:\\projects");
      const expected = join(fakeHome, ".mini-pi", WORKSPACE_MEMORY_FILE);
      assert.strictEqual(await readRememberedWorkspace(expected), "D:\\projects");
    } finally {
      if (savedHome === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = savedHome;
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
