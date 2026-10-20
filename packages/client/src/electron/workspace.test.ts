/**
 * "这次启动用哪个工作区"的裁决。
 *
 * 桌面壳没有默认工作区，因此这个函数是那条规则唯一的执行处：
 * 显式指定 > 记忆 > 询问。三条各自的边界都要钉住——
 * - 记忆里的目录被删了，不能拿一个死路径起服务；
 * - 用户取消，不能替他挑一个；
 * - 没有选择的手段（浏览器形态），要明说而不是退回启动目录。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDesktopWorkspace } from "./workspace";
import {
  WORKSPACE_MEMORY_FILE,
  readRememberedWorkspace,
} from "../server/workspaceMemory";

/** 一个真实存在的目录：断言"解析结果就是它"时用 */
function realDir(prefix: string): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** 临时记忆文件 */
function tempMemory(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "minipi-resolve-"));
  return {
    file: join(dir, WORKSPACE_MEMORY_FILE),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeMemory(file: string, workspace: string): void {
  const dir = join(file, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ workspace })}\n`, "utf8");
}

/** 一个假的目录框：记录被问了几次 */
function picker(picked: string | null): { pick: () => Promise<string | null>; asked: () => number } {
  let asked = 0;
  return {
    pick: async () => {
      asked += 1;
      return picked;
    },
    asked: () => asked,
  };
}

describe("resolveDesktopWorkspace", () => {
  it("显式 --cwd 优先：不问，也不读写记忆", async () => {
    const memory = tempMemory();
    try {
      writeMemory(memory.file, "/remembered/but/not/used");
      const ask = picker(null);

      const result = await resolveDesktopWorkspace(
        { cwd: "D:\\explicit", cwdGiven: true },
        { pick: ask.pick, memoryFile: memory.file },
      );

      assert.deepStrictEqual(result, { kind: "ok", root: "D:\\explicit" });
      assert.strictEqual(ask.asked(), 0, "指定了就别问");
      // 一次性指定不该把"下次开哪儿"改掉
      assert.ok(readFileSync(memory.file, "utf8").includes("/remembered/but/not/used"));
    } finally {
      memory.cleanup();
    }
  });

  it("记忆里的目录还在：直接开，不再问", async () => {
    const memory = tempMemory();
    const remembered = realDir("minipi-remembered-");
    try {
      writeMemory(memory.file, remembered.path);
      const ask = picker("/should/not/be/used");

      const result = await resolveDesktopWorkspace(
        { cwd: "D:\\unused", cwdGiven: false },
        { pick: ask.pick, memoryFile: memory.file },
      );

      assert.deepStrictEqual(result, { kind: "ok", root: remembered.path });
      assert.strictEqual(ask.asked(), 0, "记着就不该再问");
    } finally {
      memory.cleanup();
      remembered.cleanup();
    }
  });

  it("记忆里的目录没了：再问一次", async () => {
    const memory = tempMemory();
    const picked = realDir("minipi-repicked-");
    try {
      writeMemory(memory.file, join(tmpdir(), "mini-pi-deleted-long-ago"));
      const ask = picker(picked.path);

      const result = await resolveDesktopWorkspace(
        { cwd: "D:\\unused", cwdGiven: false },
        { pick: ask.pick, memoryFile: memory.file },
      );

      assert.deepStrictEqual(result, { kind: "ok", root: picked.path });
      assert.strictEqual(ask.asked(), 1);
    } finally {
      memory.cleanup();
      picked.cleanup();
    }
  });

  it("没有记忆：弹框问，选完记住（下次就不再问）", async () => {
    const memory = tempMemory();
    const picked = realDir("minipi-picked-");
    try {
      const ask = picker(picked.path);

      const result = await resolveDesktopWorkspace(
        { cwd: "D:\\unused", cwdGiven: false },
        { pick: ask.pick, memoryFile: memory.file },
      );

      assert.deepStrictEqual(result, { kind: "ok", root: picked.path });
      // 走读取那一侧断言：文件里是 JSON，反斜杠会被转义，直接比字符串会假红
      assert.strictEqual(await readRememberedWorkspace(memory.file), picked.path);
    } finally {
      memory.cleanup();
      picked.cleanup();
    }
  });

  /**
   * 取消时**不能**给一个默认值：那正是"桌面壳悄悄绑到一个随机目录"的
   * 老问题，只是用户没看见。调用方（主进程）据此退出。
   */
  it("用户取消：返回 cancelled，不起服务", async () => {
    const memory = tempMemory();
    try {
      const result = await resolveDesktopWorkspace(
        { cwd: process.cwd(), cwdGiven: false },
        { pick: picker(null).pick, memoryFile: memory.file },
      );

      assert.deepStrictEqual(result, { kind: "cancelled" });
      assert.ok(!existsSync(memory.file), "取消不该留下任何记忆");
    } finally {
      memory.cleanup();
    }
  });

  it("没有选择的手段（浏览器形态）且没有记忆：明说，而不是退回 cwd", async () => {
    const memory = tempMemory();
    try {
      const result = await resolveDesktopWorkspace(
        { cwd: process.cwd(), cwdGiven: false },
        { memoryFile: memory.file },
      );

      assert.strictEqual(result.kind, "missing");
      assert.ok(result.kind === "missing" && result.message.includes("--cwd"), result.kind);
      assert.ok(!result.kind.startsWith("ok"), "绝不把启动目录当默认工作区");
    } finally {
      memory.cleanup();
    }
  });

  it("选了个不是目录的路径：报出来，不记也不用", async () => {
    const memory = tempMemory();
    try {
      const result = await resolveDesktopWorkspace(
        { cwd: process.cwd(), cwdGiven: false },
        {
          pick: async () => join(tmpdir(), "mini-pi-a-file-not-a-dir"),
          memoryFile: memory.file,
        },
      );

      assert.strictEqual(result.kind, "missing");
      assert.ok(!existsSync(memory.file), "不可用的路径不该被记住");
    } finally {
      memory.cleanup();
    }
  });
});
