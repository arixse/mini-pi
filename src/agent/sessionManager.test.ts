import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { SessionManager } from "./sessionManager";
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

describe("SessionManager", () => {
  let sessionManager: SessionManager;
  const testWorkspace = join(process.cwd(), "test-workspace");
  const sessionsDir = join(homedir(), ".mini-pi", "sessions");

  beforeEach(() => {
    // 创建测试工作目录
    if (!existsSync(testWorkspace)) {
      mkdirSync(testWorkspace, { recursive: true });
    }
    sessionManager = new SessionManager(testWorkspace);
  });

  afterEach(() => {
    // 清理测试创建的会话文件（可选，为了不污染真实 sessions 目录）
    // 注意：在实际测试中，你可能希望使用临时目录
  });

  it("should create a new session with timestamp filename", () => {
    const session = sessionManager.createNewSession();
    
    assert.ok(session);
    assert.strictEqual(session.getSessionId(), "mini-pi-session");
  });

  it("should list sessions", () => {
    // 先创建一个 session
    sessionManager.createNewSession();
    
    const sessions = sessionManager.listSessions();
    
    assert.ok(Array.isArray(sessions));
    // 至少有一个 session
    assert.ok(sessions.length > 0);
    
    // 检查 session 文件名格式
    const lastSession = sessions[sessions.length - 1];
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.jsonl$/.test(lastSession.fileName));
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(lastSession.timestamp));
  });

  it("should load latest session", () => {
    // 先创建一个 session
    const firstSession = sessionManager.createNewSession();
    
    // 加载最近的 session
    const loadedSession = sessionManager.loadLatestSession();
    
    assert.ok(loadedSession);
    // 应该是同一个 session
    assert.strictEqual(loadedSession.getSessionId(), firstSession.getSessionId());
  });

  it("should get current session", () => {
    assert.strictEqual(sessionManager.getCurrentSession(), null);
    
    const session = sessionManager.createNewSession();
    
    assert.strictEqual(sessionManager.getCurrentSession(), session);
  });

  it("should set model", () => {
    // 这里只是测试方法存在，不需要真实的 model
    assert.strictEqual(typeof sessionManager.setModel, "function");
  });

  it("should get fixed context from AGENTS.md files", () => {
    const globalAgentsPath = join(homedir(), ".mini-pi", "AGENTS.md");
    const projectAgentsPath = join(testWorkspace, "AGENTS.md");

    // 创建测试 AGENTS.md 文件
    const testGlobalContent = "# 全局规则\n这是全局规则";
    const testProjectContent = "# 项目规则\n这是项目规则";

    try {
      // 创建全局 AGENTS.md
      const globalDir = join(homedir(), ".mini-pi");
      if (!existsSync(globalDir)) {
        mkdirSync(globalDir, { recursive: true });
      }
      writeFileSync(globalAgentsPath, testGlobalContent, "utf8");

      // 创建项目 AGENTS.md
      writeFileSync(projectAgentsPath, testProjectContent, "utf8");

      // 重新创建 sessionManager 以读取新文件
      sessionManager = new SessionManager(testWorkspace);

      const fixedContext = sessionManager.getFixedContext();

      // 验证固定上下文包含两个文件的内容
      assert.ok(fixedContext.includes("全局代理规则"));
      assert.ok(fixedContext.includes("项目代理规则"));
      assert.ok(fixedContext.includes("全局规则"));
      assert.ok(fixedContext.includes("项目规则"));
      assert.ok(fixedContext.includes("固定上下文"));
    } finally {
      // 清理测试文件
      try {
        if (existsSync(globalAgentsPath)) {
          unlinkSync(globalAgentsPath);
        }
        if (existsSync(projectAgentsPath)) {
          unlinkSync(projectAgentsPath);
        }
      } catch (error) {
        // 忽略清理错误
      }
    }
  });

  it("should return empty string when no AGENTS.md files exist", () => {
    // 确保没有 AGENTS.md 文件
    const globalAgentsPath = join(homedir(), ".mini-pi", "AGENTS.md");
    const projectAgentsPath = join(testWorkspace, "AGENTS.md");

    try {
      // 删除可能存在的文件
      if (existsSync(globalAgentsPath)) {
        unlinkSync(globalAgentsPath);
      }
      if (existsSync(projectAgentsPath)) {
        unlinkSync(projectAgentsPath);
      }
    } catch (error) {
      // 忽略删除错误
    }

    // 重新创建 sessionManager
    sessionManager = new SessionManager(testWorkspace);

    const fixedContext = sessionManager.getFixedContext();

    assert.strictEqual(fixedContext, "");
  });

  it("should get fixed context with only global AGENTS.md", () => {
    const globalAgentsPath = join(homedir(), ".mini-pi", "AGENTS.md");
    const projectAgentsPath = join(testWorkspace, "AGENTS.md");

    const testGlobalContent = "# 全局规则\n这是全局规则";

    try {
      // 只创建全局 AGENTS.md
      const globalDir = join(homedir(), ".mini-pi");
      if (!existsSync(globalDir)) {
        mkdirSync(globalDir, { recursive: true });
      }
      writeFileSync(globalAgentsPath, testGlobalContent, "utf8");

      // 确保项目 AGENTS.md 不存在
      if (existsSync(projectAgentsPath)) {
        unlinkSync(projectAgentsPath);
      }

      // 重新创建 sessionManager
      sessionManager = new SessionManager(testWorkspace);

      const fixedContext = sessionManager.getFixedContext();

      assert.ok(fixedContext.includes("全局代理规则"));
      assert.ok(fixedContext.includes("全局规则"));
      assert.ok(!fixedContext.includes("项目代理规则"));
    } finally {
      // 清理测试文件
      try {
        if (existsSync(globalAgentsPath)) {
          unlinkSync(globalAgentsPath);
        }
      } catch (error) {
        // 忽略清理错误
      }
    }
  });
});
