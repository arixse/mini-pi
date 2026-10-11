/**
 * 工作区边界与凭据守卫。
 *
 * 这一层回答两个问题：**这个路径能不能碰**、**这条命令碰不碰得到不该碰的东西**。
 * 文件类工具与 bash 共用同一套判定，因此放在一个模块里，避免"读写有守卫、bash 没有"
 * 这种只在一条路径上成立的承诺。
 *
 * 重要边界：这些检查都是**尽力而为的静态检查**。bash 通过 shell 执行任意命令，
 * `node -e "..."`、变量拼接、编码变换都拦不住，真正的防线是执行前的用户审批
 * （`beforeToolCall`，见 `src/cli/approval.ts`）。
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * 把路径解析到工作区内，并做两层校验：
 *
 * 1. 词法校验：resolve 之后必须仍位于 workspaceRoot 内（挡住 `..` 与绝对路径）；
 * 2. 真实路径校验：逐段解析 symlink / junction（含尚不存在的末段），
 *    挡住「工作区内的软链接指向外部」这类逃逸。
 *
 * 返回词法路径（便于调用方按 workspaceRoot 计算相对路径）；
 * 由于第 2 步已保证其真实路径位于工作区内，后续 I/O 是安全的。
 */
export function resolveInsideWorkspace(workspaceRoot: string, input: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("Path cannot be empty");
  }

  const root = resolve(workspaceRoot);
  const target = resolve(root, input);

  assertInsideRoot(root, target, input);
  assertInsideRoot(realpathSync(root), realpathAllowMissing(target), input);

  return target;
}

function assertInsideRoot(root: string, target: string, input: string): void {
  const rel = relative(root, target);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new Error(`Path escapes workspace:${input}`);
  }
}

/**
 * 解析真实路径；末段（甚至中间若干段）尚不存在时，用最近的存在祖先解析后拼回剩余部分。
 * 这样 write_file 创建新文件时也能做 symlink 校验。
 */
function realpathAllowMissing(target: string): string {
  const missing: string[] = [];
  let current = target;

  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`Cannot resolve real path: ${target}`);
      }
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * 凭据类文件名：默认禁止 read_file / write_file / edit_file 访问。
 *
 * 系统提示词里已经写了「禁止读取 .env」，但此前只是提示，模型仍可直接读到；
 * 这里把它落到工具层强制生效。模板文件（.env.example 等）本身不含真实凭据，允许访问。
 */
const CREDENTIAL_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env$/,                       // .env
  /^\.env\./i,                     // .env.local / .env.production ...
  /^id_(rsa|dsa|ecdsa|ed25519)$/i, // SSH 私钥
  /\.pem$/i,
  /^\.git-credentials$/i,
];

const CREDENTIAL_TEMPLATE_PATTERN = /^\.env\.(example|sample|template)$/i;

export function isCredentialFile(filePath: string): boolean {
  const name = basename(filePath);
  if (CREDENTIAL_TEMPLATE_PATTERN.test(name)) {
    return false;
  }
  return CREDENTIAL_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/** @throws 命中凭据文件时抛出可读错误 */
export function assertNotCredentialFile(filePath: string, workspaceRoot: string): void {
  if (!isCredentialFile(filePath)) {
    return;
  }
  throw new Error(
    `Refusing to access credential file: ${relative(workspaceRoot, filePath)}. ` +
      `凭据类文件（.env、私钥等）默认禁止读写；如确需处理，请先向用户说明并取得同意。`,
  );
}

/** 命令里"片段"的分隔符：shell 元字符与引号 */
const COMMAND_FRAGMENT_SPLIT = /[\s"'`;|&<>()$]+/;
/** 片段内部再按这些字符切开：`--file=.env`、`config/.env` 都要能命中 */
const FRAGMENT_INNER_SPLIT = /[=:\\/]+/;

/**
 * 找出命令里提到的凭据类文件。
 *
 * 做法上刻意"宁可多报"：把命令按 shell 元字符切成片段，片段再按
 * `= : \ /` 切开，逐段用 {@link isCredentialFile} 判定。
 * 这样 `cat .env`、`cat ./config/.env`、`--file=.env`、`grep x .env`
 * 都能命中，而 `dotenv`、`foo.env` 这类同形名字不会误伤
 * （模板文件 .env.example 由 isCredentialFile 排除）。
 *
 * 静态检查拦不住 `node -e "..."` 之类的构造，这里只是第一道闸，
 * 最终防线仍是执行前的用户审批。
 */
export function findCredentialMentions(command: string): string[] {
  const hits = new Set<string>();

  for (const fragment of command.split(COMMAND_FRAGMENT_SPLIT)) {
    if (fragment === "") {
      continue;
    }
    for (const piece of fragment.split(FRAGMENT_INNER_SPLIT)) {
      if (piece !== "" && isCredentialFile(piece)) {
        hits.add(piece);
      }
    }
  }

  return [...hits];
}

/** `$HOME` / `%USERPROFILE%` 这类指向工作区之外的引用 */
const HOME_REFERENCE_PATTERN = /\$HOME\b|%USERPROFILE%|%HOMEPATH%|\$env:USERPROFILE/i;

/** 类 URL 片段（`https://x`、`s3://b`）先剔除，避免把 `//` 误判为 POSIX 根路径 */
const URL_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"']*/g;

/**
 * 文本中的绝对路径：Windows 盘符 / UNC / POSIX 根。
 *
 * 要求路径前面是「起点或分隔符」，这样才不会被相对路径与表达式误伤：
 * - `s/a/../b/` 里的 `/b/` 前面是 `.`，不算绝对路径；
 * - `a/b` 里的 `/` 前面是单词字符，不算；
 * - `cat /etc/passwd`、`--file=/etc/x`、`readFileSync('/etc/x')` 都能命中；
 * - `~/x` 里 `/` 前面是 `~`，因此交给 token 的 `~` 规则处理。
 */
const ABSOLUTE_PATH_IN_TEXT =
  /(?:^|[\s=:;|&<>("'`])((?:[a-zA-Z]:[\\/]|\\\\|\/)[^\s"']*)/g;

/**
 * token 内的 `..` 路径段：两侧不能是普通单词字符或点，
 * 以免命中 `a..b` 这类合法名字；`s/../x/` 这类会命中，
 * 但后续的真实路径校验会确认它仍在工作区内，因此不会误报。
 */
const TRAVERSAL_IN_TOKEN = /(?:^|[^A-Za-z0-9._-])\.\.(?:[^A-Za-z0-9._-]|$)/;

/** Windows 上形如 `/b`、`/s` 的开关，豁免 POSIX 绝对路径判定（dir /b、findstr /s） */
const WINDOWS_SWITCH_LIKE = /^\/[A-Za-z]{1,3}$/;

/** 未被引号包裹时，反斜杠后面出现这些字符才视为转义（否则按字面保留，兼容 Windows 路径） */
const UNQUOTED_ESCAPABLE = new Set([
  '"',
  "'",
  "\\",
  "/",
  " ",
  "$",
  "`",
  "|",
  "&",
  ";",
  "<",
  ">",
  "(",
  ")",
]);

/**
 * 按 shell 词法切分命令：处理单/双引号与反斜杠转义，
 * 并把 `| & ; < > ( )` 作为独立分隔符返回。
 *
 * 反斜杠的处理需要同时兼顾两种 shell：
 * - POSIX sh：`\x` 会去掉反斜杠；`\/` 也是 `/`；
 * - Windows cmd：`\` 是路径分隔符，`..\..` 不能被反转义成 `....`。
 *
 * 因此只有「反斜杠 + 可能被转义的字符」才做反转义，其余场合保留反斜杠本身。
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  const flush = (): void => {
    if (started) {
      tokens.push(current);
    }
    current = "";
    started = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    const next = command[i + 1];

    if (quote === "'") {
      // 单引号内没有转义
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && (next === '"' || next === "\\" || next === "$" || next === "`")) {
        i += 1;
        current += next;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && next !== undefined && UNQUOTED_ESCAPABLE.has(next)) {
      i += 1;
      current += next === "/" ? "/" : next;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if ("|;&<>()".includes(char)) {
      flush();
      tokens.push(char);
      continue;
    }

    current += char;
    started = true;
  }

  flush();
  return tokens;
}

/**
 * 从命令中提取需要校验的路径候选。
 * 返回的是「按 shell 语义去引号后」的片段，因此 `cat "D:\x"` 也能被识别。
 */
export function extractPathCandidates(command: string): string[] {
  const candidates = new Set<string>();

  // 1) 整条命令中出现的绝对路径（含字符串内部拼接出来的）
  const scanned = command.replace(URL_PATTERN, " ");
  for (const match of scanned.matchAll(ABSOLUTE_PATH_IN_TEXT)) {
    const value = match[1];
    if (process.platform === "win32" && WINDOWS_SWITCH_LIKE.test(value)) {
      continue;
    }
    candidates.add(value);
  }

  // 2) 逐个 token：~ 开头、或含 .. 路径段
  for (const token of tokenizeCommand(command)) {
    if (token.startsWith("~")) {
      candidates.add(token);
      continue;
    }
    if (TRAVERSAL_IN_TOKEN.test(token)) {
      candidates.add(token);
    }
  }

  return [...candidates];
}

/**
 * bash 工具的路径守卫。
 *
 * 除了路径逃逸，这里还复用 {@link isCredentialFile} 拦住凭据类文件：
 * 此前凭据保护只挂在 read_file / write_file / edit_file 上，`cat .env`
 * （相对路径、既非绝对路径也不含 `..`）会**完全绕过**检查，README 里
 * "默认禁止读写"的承诺在 bash 路径上并不成立。
 *
 * 相比旧实现（按空白切分 token + 正则匹配 token 开头）的关键改进：
 * - 先做引号感知的词法切分并去掉引号/转义，`cat "D:\secret.txt"` 不再漏检；
 * - 同时扫描整条命令，能发现写在字符串内部拼接出来的绝对路径；
 * - 识别出的路径统一走 resolveInsideWorkspace 的**真实路径**校验；
 * - 只在确实逃逸出工作区时才拒绝，`sed 's/../x/'` 这类误报被消除。
 */
export function checkBashCommand(command: string, workspaceRoot: string): void {
  if (HOME_REFERENCE_PATTERN.test(command)) {
    throw new Error(
      "Bash command references a home-directory variable, which is outside the workspace: " +
        command.match(HOME_REFERENCE_PATTERN)![0],
    );
  }

  const credentials = findCredentialMentions(command);
  if (credentials.length > 0) {
    throw new Error(
      `Bash command touches credential file(s): ${credentials.join(", ")}. ` +
        `凭据类文件（.env、私钥、*.pem、.git-credentials）默认禁止读写；` +
        `如确需处理，请先向用户说明并取得同意。`,
    );
  }

  for (const candidate of extractPathCandidates(command)) {
    if (candidate.startsWith("~")) {
      throw new Error(
        `Bash command contains a home-directory path outside the workspace: ${candidate}`,
      );
    }
    try {
      resolveInsideWorkspace(workspaceRoot, candidate);
    } catch {
      throw new Error(
        `Bash command contains a path outside the workspace: ${candidate}`,
      );
    }
  }
}
