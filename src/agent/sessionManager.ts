import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { JsonlSessionStore } from "./sessionStore";
import { LlmModel } from "./model";
import { SkillLoader, SkillSource, SkillWithSource } from "./skillLoader";

export interface SessionManagerOptions {
  /** 自定义 skill 目录列表（用于测试） */
  customSkillDirs?: Array<{ path: string; source: SkillSource }>;
  /** 会话存储目录，默认 ~/.mini-pi/sessions */
  sessionsDir?: string;
  /** 全局 AGENTS.md 路径，默认 ~/.mini-pi/AGENTS.md */
  globalAgentsPath?: string;
}

/** 会话列表条目 */
export interface SessionInfo {
  fileName: string;
  timestamp: string;
  /** 会话文件的绝对路径 */
  path: string;
  sizeBytes: number;
}

/** 会话子目录里记录归属的文件名；用于消解"两个路径映射到同一个目录名"的碰撞 */
const WORKSPACE_MARKER = ".workspace-key";
/** 目录名的最大长度：Windows 的 MAX_PATH 有限，超长时保留尾部（项目名那一截更有区分度） */
const MAX_DIR_NAME_LENGTH = 120;

/**
 * 工作目录的绝对真实路径（不做大小写归一）。
 *
 * `realpathSync` 解开软链接（macOS 的 `/var` → `/private/var` 同理）；
 * 目录不存在时它会抛错，退回 `resolve` 的结果（首次启动的新目录走这条路）。
 */
function absolutePath(workspaceRoot: string): string {
  try {
    return realpathSync(resolve(workspaceRoot));
  } catch {
    return resolve(workspaceRoot);
  }
}

/**
 * 归一化工作目录，作为"这个会话属于哪个目录"的判定键。
 *
 * 同一个目录有多种写法（相对路径、尾斜杠、软链接；Windows 上还有大小写差异，
 * 而进程拿到的是 `chdir` 时的原始字符串）。不归一化的话，换个写法 `cd` 进同一个
 * 项目就会另起一串会话，看起来像"历史凭空丢了"。
 *
 * Windows 大小写不敏感，统一转小写，否则 `d:\work` 与 `D:\WORK` 会被算成两个目录。
 */
export function normalizeWorkspaceKey(workspaceRoot: string): string {
  const absolute = absolutePath(workspaceRoot);
  return platform() === "win32" ? absolute.toLowerCase() : absolute;
}

/** 判定键的短哈希，仅在目录名碰撞时用来消歧 */
export function workspaceKeyHash(workspaceRoot: string): string {
  return createHash("sha256")
    .update(normalizeWorkspaceKey(workspaceRoot))
    .digest("hex")
    .slice(0, 8);
}

/**
 * 工作目录对应的会话子目录名：把**完整路径**铺平，`D:/workspace/mini-pi`
 * → `--D--workspace-mini-pi--`。
 *
 * 这么命名是为了查找：`ls ~/.mini-pi/sessions/` 就能直接看出哪个目录属于哪个项目，
 * 不需要哈希对照表。规则：
 * - 首尾包裹 `--` 作边界，让"路径分隔符变来的 `-`"与"路径里本来的 `-`"可区分；
 * - 路径分隔符、盘符冒号与空格等（Windows 文件名非法字符）逐个替换为 `-`，
 *   于是 `D:` + `\` 会变成 `--`，与示例一致；
 * - 中文等合法字符**保留**（落盘没问题，且查找时更直观）；
 * - 超长时只保留尾部若干字符（末尾是项目名，区分度更高）。
 *
 * 铺的是**归一化后**的路径（Windows 上已小写）：大小写不归一的话，`D:\work` 与
 * `d:\WORK` 会算出两个名字，同一个项目出现两个会话目录，历史又"分家"了。
 *
 * 注意这种映射不是单射：路径里含空格、`*` 等在 Windows 上非法的字符时，
 * `a b/c` 与 `a-b/c` 会映射到同一个名字。因此调用方还要用 {@link WORKSPACE_MARKER}
 * 做一次碰撞消歧，不能只靠名字判定归属。
 */
export function workspaceSessionDirName(workspaceRoot: string): string {
  const label = normalizeWorkspaceKey(workspaceRoot)
    .replace(/^[\\/:]+/, "")
    .replace(/[\\/:]+$/, "")
    .replace(/[\\/:*?"<>|\s]/g, "-");
  const kept =
    label.length > MAX_DIR_NAME_LENGTH
      ? label.slice(-MAX_DIR_NAME_LENGTH)
      : label;
  return `--${kept}--`;
}

export class SessionManager {
  private readonly sessionsDir: string;
  /** 归一化后的工作目录，判定会话归属与写标记用 */
  private readonly workspaceKey: string;
  /** 本工作目录专属的会话子目录：会话隔离的唯一依据 */
  private readonly projectSessionsDir: string;
  private readonly globalAgentsPath: string;
  private readonly projectAgentsPath: string;
  private currentSession: JsonlSessionStore | null = null;
  private model: LlmModel | null = null;
  private readonly skillLoader: SkillLoader;

  constructor(private readonly workspaceRoot: string, options?: SessionManagerOptions) {
    // 可注入：单元测试必须能完全避开真实的 ~/.mini-pi，
    // 否则测试会读写甚至删除用户的真实配置与历史会话。
    this.sessionsDir = options?.sessionsDir ?? join(homedir(), ".mini-pi", "sessions");
    this.workspaceKey = normalizeWorkspaceKey(workspaceRoot);
    this.projectSessionsDir = this.resolveProjectSessionsDir();
    this.globalAgentsPath =
      options?.globalAgentsPath ?? join(homedir(), ".mini-pi", "AGENTS.md");
    this.projectAgentsPath = join(workspaceRoot, "AGENTS.md");
    this.skillLoader = new SkillLoader(workspaceRoot, options?.customSkillDirs);
    this.ensureSessionsDir();
  }

  /**
   * 解析本工作目录的会话子目录。
   *
   * 目录名由路径铺平而来，而这条映射**不是单射**（见 `workspaceSessionDirName`）：
   * 两个不同的工作目录可能算出同一个名字，共用它就等于让两个项目共享一串会话。
   * 因此目录里放一个标记文件记录归属 key：名字撞车且标记属于别的目录时，
   * 追加一段哈希消歧。标记缺失（用户手建、旧版本遗留）则认领并补写。
   */
  private resolveProjectSessionsDir(): string {
    const name = workspaceSessionDirName(this.workspaceRoot);
    const candidate = join(this.sessionsDir, name);
    const owner = this.readWorkspaceMarker(candidate);
    if (owner !== null && owner !== this.workspaceKey) {
      return join(
        this.sessionsDir,
        `${name}-${workspaceKeyHash(this.workspaceRoot)}`,
      );
    }
    return candidate;
  }

  /** 读目录下的归属标记；不存在或读不出时返回 null（视为"无人认领"） */
  private readWorkspaceMarker(dir: string): string | null {
    try {
      const raw = readFileSync(join(dir, WORKSPACE_MARKER), "utf8").trim();
      return raw.length > 0 ? raw : null;
    } catch {
      return null;
    }
  }

  /** 当前工作目录 */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /** 本工作目录的会话存放目录（/status、测试断言用） */
  getSessionDir(): string {
    return this.projectSessionsDir;
  }

  setModel(model: LlmModel): void {
    this.model = model;
    if (this.currentSession) {
      this.currentSession.setModel(model);
    }
  }

  /**
   * 确保**本工作目录**的会话子目录存在，并写下归属标记。
   *
   * 建的是子目录而不是 `sessionsDir` 根：`recursive` 会顺带把根目录建出来，
   * 而只建根目录的话，第一次写会话文件时才会补建子目录——中间任何一次列举
   * 都会看到"目录不存在"的空结果。
   *
   * 标记文件写失败不用管：它只用于碰撞消歧，会话本身照常存。
   */
  private ensureSessionsDir(): void {
    if (!existsSync(this.projectSessionsDir)) {
      mkdirSync(this.projectSessionsDir, { recursive: true });
    }
    const marker = join(this.projectSessionsDir, WORKSPACE_MARKER);
    if (!existsSync(marker)) {
      try {
        writeFileSync(marker, `${this.workspaceKey}\n`, "utf8");
      } catch {
        // 只读也能用，只是下次可能要重新认领
      }
    }
  }

  /**
   * 读取 AGENTS.md 文件内容
   * @returns AGENTS.md 内容，如果文件不存在则返回空字符串
   */
  private readAgentsFile(filePath: string): string {
    try {
      if (existsSync(filePath)) {
        return readFileSync(filePath, "utf8");
      }
    } catch (error) {
      console.error(`读取 ${filePath} 失败:`, error);
    }
    return "";
  }

  /**
   * 获取固定上下文（来自 AGENTS.md 文件）
   * @returns 固定上下文内容
   */
  getFixedContext(): string {
    const parts: string[] = [];

    // 读取全局 AGENTS.md
    const globalAgents = this.readAgentsFile(this.globalAgentsPath);
    if (globalAgents) {
      parts.push(`## 全局代理规则\n\n${globalAgents}`);
    }

    // 读取项目 AGENTS.md
    const projectAgents = this.readAgentsFile(this.projectAgentsPath);
    if (projectAgents) {
      parts.push(`## 项目代理规则\n\n${projectAgents}`);
    }

    if (parts.length === 0) {
      return "";
    }

    return `# 固定上下文\n\n以下是来自 AGENTS.md 的规则，请在回答时遵循这些规则：\n\n${parts.join("\n\n---\n\n")}`;
  }

  /**
   * 获取 SkillLoader 实例
   */
  getSkillLoader(): SkillLoader {
    return this.skillLoader;
  }

  /**
   * 加载所有 skill 的元数据（轻量级操作）
   */
  loadSkillMetadata(): SkillWithSource[] {
    return this.skillLoader.loadAllMetadata();
  }

  /**
   * 按需加载单个 skill 的完整内容
   * @param skillName skill 名称
   * @returns skill 内容，如果未找到则返回 null
   */
  loadSkillContent(skillName: string): string | null {
    const skill = this.skillLoader.loadSkill(skillName);
    return skill ? skill.content : null;
  }

  /**
   * 根据用户输入查找匹配的 skills
   * @param userInput 用户输入
   * @returns 匹配的 skill 列表
   */
  findMatchingSkills(userInput: string): SkillWithSource[] {
    return this.skillLoader.findMatchingSkills(userInput);
  }

  /**
   * 生成 skill 摘要（用于注入 system prompt）
   */
  getSkillSummary(): string {
    return this.skillLoader.generateSkillSummary();
  }

  /**
   * 创建新的 session
   *
   * 会话文件落在**本工作目录**的子目录里：不同工作目录的会话互不干扰，
   * `/sessions`、`/switch`、启动恢复三者看到的是同一份集合。
   *
   * @returns 新创建的 session store
   */
  createNewSession(): JsonlSessionStore {
    return this.openSession(this.allocateSessionPath());
  }

  /**
   * 分配一个未被占用的会话文件路径。
   *
   * 时间戳只到秒，两个进程在同一秒启动（或同一进程被快速调用两次）会得到同一个
   * 文件名，而 `JsonlSessionStore` 对已存在的文件是**追加**——于是两次启动的会话
   * 会写进同一个文件，互相看到对方的历史。这里检测占用并加后缀避开。
   */
  private allocateSessionPath(): string {
    const timestamp = this.generateTimestamp();
    let path = join(this.projectSessionsDir, `${timestamp}.jsonl`);
    let suffix = 1;
    while (existsSync(path)) {
      suffix += 1;
      path = join(this.projectSessionsDir, `${timestamp}-${suffix}.jsonl`);
    }
    return path;
  }

  /**
   * 打开会话文件并设为当前会话。
   *
   * 新建与加载共用这一处：模型绑定与 `currentSession` 赋值只写一遍，
   * 避免以后某个入口漏掉 `setModel`（压缩时没有模型就只能出降级摘要）。
   */
  private openSession(filePath: string): JsonlSessionStore {
    const store = new JsonlSessionStore(filePath, this.workspaceRoot);
    if (this.model) {
      store.setModel(this.model);
    }
    this.currentSession = store;
    return store;
  }

  /**
   * 获取当前 session
   */
  getCurrentSession(): JsonlSessionStore | null {
    return this.currentSession;
  }

  /**
   * 加载**本工作目录**最近的一个 session
   * @returns 最近的 session store，如果没有则创建新的
   */
  loadLatestSession(): JsonlSessionStore {
    const sessions = this.listSessions();

    if (sessions.length > 0) {
      // 加载最近的 session（列表按文件名即时间排序，最后一个最新）
      return this.openSession(sessions[sessions.length - 1].path);
    }

    // 如果没有 session，创建新的
    return this.createNewSession();
  }

  /**
   * 列出**当前工作目录**的所有 session 文件。
   *
   * 只扫描该目录对应的子目录，别的目录的会话既不列出也不可切换——
   * 目录维度就是隔离边界，不需要（也不应该）再按会话头里的 cwd 过滤一遍。
   */
  listSessions(): SessionInfo[] {
    if (!existsSync(this.projectSessionsDir)) {
      return [];
    }

    let files: string[];
    try {
      files = readdirSync(this.projectSessionsDir)
        .filter(file => file.endsWith(".jsonl"))
        .sort(); // 按文件名排序，也就是按时间排序
    } catch {
      return [];
    }

    return files.map(fileName => {
      const filePath = join(this.projectSessionsDir, fileName);
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(filePath).size;
      } catch {
        // 读不到大小不影响列举
      }
      return {
        fileName,
        timestamp: fileName.replace(/\.jsonl$/, ""),
        path: filePath,
        sizeBytes,
      };
    });
  }

  /**
   * 加载**当前工作目录**内的指定会话并设为当前会话。
   *
   * @param target 会话序号（1 起，对应 listSessions 的顺序）或文件名/时间戳
   * @returns 加载好的 session store；找不到时返回 null
   */
  loadSession(target: string): JsonlSessionStore | null {
    const sessions = this.listSessions();
    const trimmed = target.trim();
    if (sessions.length === 0 || trimmed === "") {
      return null;
    }

    // 解析成列表里的**路径**：序号与文件名都只在当前工作目录的列表里找，
    // 因此别的目录的会话既列不出来也切不过去
    let path: string | undefined;
    if (/^\d+$/.test(trimmed)) {
      const index = Number(trimmed);
      if (index < 1 || index > sessions.length) {
        return null;
      }
      path = sessions[index - 1].path;
    } else {
      const wanted = trimmed.endsWith(".jsonl") ? trimmed : `${trimmed}.jsonl`;
      path = sessions.find(session => session.fileName === wanted)?.path;
    }

    if (!path) {
      return null;
    }

    return this.openSession(path);
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
