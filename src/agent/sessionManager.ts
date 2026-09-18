import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { JsonlSessionStore } from "./sessionStore";
import { LlmModel } from "./model";

export class SessionManager {
  private readonly sessionsDir: string;
  private currentSession: JsonlSessionStore | null = null;
  private model: LlmModel | null = null;

  constructor(private readonly workspaceRoot: string) {
    this.sessionsDir = join(homedir(), ".mini-pi", "sessions");
    this.ensureSessionsDir();
  }

  setModel(model: LlmModel): void {
    this.model = model;
    if (this.currentSession) {
      this.currentSession.setModel(model);
    }
  }

  private ensureSessionsDir(): void {
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  /**
   * 创建新的 session
   * @returns 新创建的 session store
   */
  createNewSession(): JsonlSessionStore {
    const timestamp = this.generateTimestamp();
    const fileName = `${timestamp}.jsonl`;
    const filePath = join(this.sessionsDir, fileName);

    this.currentSession = new JsonlSessionStore(filePath, this.workspaceRoot);
    if (this.model) {
      this.currentSession.setModel(this.model);
    }

    return this.currentSession;
  }

  /**
   * 获取当前 session
   */
  getCurrentSession(): JsonlSessionStore | null {
    return this.currentSession;
  }

  /**
   * 加载最近的 session
   * @returns 最近的 session store，如果没有则创建新的
   */
  loadLatestSession(): JsonlSessionStore {
    const sessions = this.listSessions();
    
    if (sessions.length > 0) {
      // 加载最近的 session
      const latestSession = sessions[sessions.length - 1];
      const filePath = join(this.sessionsDir, latestSession.fileName);
      
      this.currentSession = new JsonlSessionStore(filePath, this.workspaceRoot);
      if (this.model) {
        this.currentSession.setModel(this.model);
      }
      
      return this.currentSession;
    }

    // 如果没有 session，创建新的
    return this.createNewSession();
  }

  /**
   * 列出所有 session 文件
   */
  listSessions(): Array<{ fileName: string; timestamp: string }> {
    if (!existsSync(this.sessionsDir)) {
      return [];
    }

    const files = readdirSync(this.sessionsDir)
      .filter(file => file.endsWith(".jsonl"))
      .sort(); // 按文件名排序，也就是按时间排序

    return files.map(fileName => ({
      fileName,
      timestamp: fileName.replace(".jsonl", ""),
    }));
  }

  /**
   * 生成时间戳文件名
   * 格式: YYYY-MM-DDTHH-mm-ss
   */
  private generateTimestamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");

    return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}`;
  }
}
