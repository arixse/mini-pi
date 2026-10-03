import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { SessionManager, SessionManagerOptions } from "./sessionManager";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillLoader } from "./skillLoader";

describe("SessionManager", () => {
  let sessionManager: SessionManager;
  let testRoot: string;
  let testWorkspace: string;
  let sessionsDir: string;
  let globalAgentsPath: string;
  let projectAgentsPath: string;

  /**
   * 构造完全隔离在临时目录中的 SessionManager。
   * 单元测试绝不能触碰真实的 ~/.mini-pi（历史会话、AGENTS.md、凭据），
   * 早期版本会往那里写会话文件、甚至删除用户的全局 AGENTS.md。
   */
  function createSessionManager(
    extra: Partial<SessionManagerOptions> = {},
  ): SessionManager {
    return new SessionManager(testWorkspace, {
      sessionsDir,
      globalAgentsPath,
      ...extra,
    });
  }

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `mini-pi-session-manager-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    testWorkspace = join(testRoot, "workspace");
    sessionsDir = join(testRoot, "sessions");
    globalAgentsPath = join(testRoot, "global-AGENTS.md");
    projectAgentsPath = join(testWorkspace, "AGENTS.md");

    mkdirSync(testWorkspace, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });

    sessionManager = createSessionManager();
  });

  afterEach(() => {
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("should create a new session with timestamp filename", () => {
    const session = sessionManager.createNewSession();
    
    assert.ok(session);
    assert.strictEqual(session.getSessionId(), "mini-pi-session");
  });

  it("should write session files into the injected sessionsDir", () => {
    sessionManager.createNewSession();

    const files = readdirSync(sessionsDir).filter((file) => file.endsWith(".jsonl"));
    assert.strictEqual(files.length, 1, "会话文件必须落在注入的目录里");
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.jsonl$/.test(files[0]));
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

  it("should list sessions with path and size", () => {
    sessionManager.createNewSession();

    const sessions = sessionManager.listSessions();

    assert.ok(sessions[0].path.endsWith(".jsonl"));
    assert.ok(sessions[0].sizeBytes > 0, "应给出文件大小");
  });

  /** 直接写一个只有会话头的文件，便于构造多个不同会话 */
  function writeSessionFile(fileName: string): void {
    writeFileSync(
      join(sessionsDir, fileName),
      `${JSON.stringify({
        type: "session",
        version: 1,
        id: "mini-pi-session",
        timestamp: new Date().toISOString(),
        cwd: testWorkspace,
      })}\n`,
      "utf8",
    );
  }

  it("should load a session by index", () => {
    writeSessionFile("2026-01-01T00-00-01.jsonl");
    writeSessionFile("2026-01-01T00-00-02.jsonl");

    const loaded = sessionManager.loadSession("1");

    assert.ok(loaded);
    assert.ok(loaded!.getFilePath().endsWith("2026-01-01T00-00-01.jsonl"));
    assert.strictEqual(sessionManager.getCurrentSession(), loaded);
  });

  it("should load a session by file name or timestamp", () => {
    writeSessionFile("2026-02-02T10-00-00.jsonl");

    const byFileName = sessionManager.loadSession("2026-02-02T10-00-00.jsonl");
    const byTimestamp = sessionManager.loadSession("2026-02-02T10-00-00");

    assert.ok(byFileName);
    assert.ok(byTimestamp);
    assert.strictEqual(byFileName!.getFilePath(), byTimestamp!.getFilePath());
  });

  it("should return null for unknown session targets", () => {
    writeSessionFile("2026-03-03T10-00-00.jsonl");

    assert.strictEqual(sessionManager.loadSession("999"), null);
    assert.strictEqual(sessionManager.loadSession("no-such-session"), null);
    assert.strictEqual(sessionManager.loadSession("  "), null);
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
    writeFileSync(globalAgentsPath, "# 全局规则\n这是全局规则", "utf8");
    writeFileSync(projectAgentsPath, "# 项目规则\n这是项目规则", "utf8");

    // 重新创建 sessionManager 以读取新文件
    sessionManager = createSessionManager();

    const fixedContext = sessionManager.getFixedContext();

    // 验证固定上下文包含两个文件的内容
    assert.ok(fixedContext.includes("全局代理规则"));
    assert.ok(fixedContext.includes("项目代理规则"));
    assert.ok(fixedContext.includes("全局规则"));
    assert.ok(fixedContext.includes("项目规则"));
    assert.ok(fixedContext.includes("固定上下文"));
  });

  it("should return empty string when no AGENTS.md files exist", () => {
    // 临时目录里本来就没有任何 AGENTS.md，不需要（也绝不能）去删真实文件
    sessionManager = createSessionManager();

    assert.strictEqual(sessionManager.getFixedContext(), "");
  });

  it("should get fixed context with only global AGENTS.md", () => {
    writeFileSync(globalAgentsPath, "# 全局规则\n这是全局规则", "utf8");

    sessionManager = createSessionManager();

    const fixedContext = sessionManager.getFixedContext();

    assert.ok(fixedContext.includes("全局代理规则"));
    assert.ok(fixedContext.includes("全局规则"));
    assert.ok(!fixedContext.includes("项目代理规则"));
  });

  // Skill 相关测试
  describe("Skill Management", () => {
    let skillDir: string;
    let isolatedSessionManager: SessionManager;

    beforeEach(() => {
      // 创建独立的 skill 目录
      skillDir = join(testRoot, "test-skills");
      mkdirSync(skillDir, { recursive: true });
      // 创建使用独立 skill 目录的 sessionManager
      isolatedSessionManager = createSessionManager({
        customSkillDirs: [{ path: skillDir, source: "project" }],
      });
    });

    afterEach(() => {
      // 由外层 afterEach 统一清理 testRoot
    });

    function createTestSkill(dirName: string, name: string, description: string) {
      const dir = join(skillDir, dirName);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nTest skill content.`,
        "utf8"
      );
    }

    it("should get skill loader instance", () => {
      const skillLoader = isolatedSessionManager.getSkillLoader();
      assert.ok(skillLoader instanceof SkillLoader);
    });

    it("should load skill metadata", () => {
      createTestSkill("test-skill", "test-skill", "A test skill");

      const metadata = isolatedSessionManager.loadSkillMetadata();
      assert.ok(Array.isArray(metadata));
      assert.strictEqual(metadata.length, 1);
      assert.strictEqual(metadata[0].name, "test-skill");
      assert.strictEqual(metadata[0].description, "A test skill");
    });

    it("should load skill content by name", () => {
      createTestSkill("my-skill", "my-skill", "My skill description");

      const content = isolatedSessionManager.loadSkillContent("my-skill");
      assert.ok(content !== null);
      assert.ok(content!.includes("# my-skill"));
      assert.ok(content!.includes("Test skill content."));
    });

    it("should return null for non-existent skill", () => {
      const content = isolatedSessionManager.loadSkillContent("non-existent");
      assert.strictEqual(content, null);
    });

    it("should find matching skills based on input", () => {
      createTestSkill("stock-analysis", "stock-analysis", "Analyze stocks and cryptocurrencies");
      createTestSkill("web-scraper", "web-scraper", "Scrape data from websites");

      const matches = isolatedSessionManager.findMatchingSkills("I want to analyze stocks");
      assert.ok(matches.length > 0);
      assert.strictEqual(matches[0].name, "stock-analysis");
    });

    it("should get skill summary for system prompt", () => {
      createTestSkill("summary-test", "summary-test", "Summary test skill");

      const summary = isolatedSessionManager.getSkillSummary();
      assert.ok(summary.length > 0);
      assert.ok(summary.includes("summary-test"));
      assert.ok(summary.includes("Summary test skill"));
      assert.ok(summary.includes("可用 Skills"));
    });

    it("should return empty summary when no skills exist", () => {
      const summary = isolatedSessionManager.getSkillSummary();
      assert.strictEqual(summary, "");
    });
  });
});
