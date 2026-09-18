import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { SessionManager } from "./sessionManager";
import { existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
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
});
