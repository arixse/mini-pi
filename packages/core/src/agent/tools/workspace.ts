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
import { existsSync, realpathSync } from "node:fs";

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

  assertNoAlternateDataStream(target, input);
  assertInsideRoot(root, target, input);
  assertInsideRoot(realpathSync(root), realpathAllowMissing(target), input);

  return target;
}

function assertInsideRoot(root: string, target: string, input: string): void {
  if (!isRealPathInside(root, target)) {
    throw new Error(`Path escapes workspace:${input}`);
  }
}

/**
 * 拒绝 Windows 备用数据流（ADS）：`.npmrc::$DATA`、`.env:stream`。
 *
 * ADS 是 NTFS 给同一文件挂的附加命名流，`read_file(".npmrc::$DATA")` 读到的
 * 正是 `.npmrc` 的内容，而 basename 变成 `.npmrc::$DATA`——凭据名单一个都匹配不上，
 * 于是"默认禁止读写凭据"在这条路径上完全失效。文件是否存在都不影响判断：
 * ADS 语法本身在这里就不该出现。
 */
function assertNoAlternateDataStream(target: string, input: string): void {
  if (process.platform !== "win32") {
    // POSIX 文件系统里 `:` 是合法文件名字符，`a:b` 是普通文件，不能误伤
    return;
  }
  // 盘符自带的冒号先摘掉，剩下的冒号只可能是流名分隔符
  const withoutDrive = target.replace(/^[A-Za-z]:/, "");
  if (withoutDrive.includes(":")) {
    throw new Error(
      `Path uses a Windows alternate data stream（ADS 可绕过凭据文件名单）:${input}`,
    );
  }
}

/**
 * 真实路径是否仍在工作区内（不抛错）。
 *
 * 与 {@link assertInsideRoot} 同一套判定，区别只是返回值而非异常。
 * 供遍历层使用：遍历中遇到的**每个** symlink / junction 都需要判定，
 * 命中工作区外时只跳过该条目，不该让整次检索失败。
 */
export function isRealPathInside(realRoot: string, realTarget: string): boolean {
  const rel = relative(realRoot, realTarget);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** 解析真实路径；断链等情况返回 null（不抛错），由调用方决定如何处理 */
export function realpathOrNull(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

/** 工作区的真实路径；工作区本身解析失败时退回词法路径 */
export function workspaceRealPath(workspaceRoot: string): string {
  const root = resolve(workspaceRoot);
  return realpathOrNull(root) ?? root;
}

/**
 * 判断相对路径是否指向工作区内**已存在**的文件。
 *
 * 只服务于审批展示（决定写文件时要不要标"覆盖"），因此逃逸出工作区或路径非法
 * 一律按"不存在"处理，不影响真正的写入校验（那在 `resolveInsideWorkspace`）。
 *
 * 放在内核里的理由与风险判定相同：终端与客户端必须给出同一句
 * 「覆盖已存在的文件」——两边各写一份，迟早有一边漏掉 `..` 的判定。
 */
export function workspaceFileExists(
  workspaceRoot: string,
  relativePath: string,
): boolean {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    return false;
  }
  try {
    const root = resolve(workspaceRoot);
    const target = resolve(root, relativePath);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return false;
    }
    return existsSync(target);
  } catch {
    return false;
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
 * 凭据类文件名：默认禁止 read_file / write_file / edit_file 访问，
 * 检索类工具（list_files / glob / grep）也不列举、不读取。
 *
 * 系统提示词里已经写了「禁止读取 .env」，但此前只是提示，模型仍可直接读到；
 * 这里把它落到工具层强制生效。模板文件（.env.example 等）本身不含真实凭据，允许访问。
 *
 * 匹配一律带 `i`：Windows 文件系统大小写不敏感，`read_file(".ENV")` 实际打开的
 * 就是 `.env`，不带 i 的规则等于留了一个只在该平台成立的洞。
 */
const CREDENTIAL_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env$/i,                        // .env / .ENV
  /^\.env\./i,                       // .env.local / .env.production ...
  /^\.npmrc$/i,                      // //registry/:_authToken=...
  /^\.yarnrc(\.yml)?$/i,
  /^\.pypirc$/i,                     // PyPI token
  /^\.netrc$/i,
  /^_netrc$/i,                       // Windows 上的 .netrc
  /^\.git-credentials$/i,
  /^credentials$/i,                  // ~/.aws/credentials
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,   // SSH 私钥
  /\.pem$/i,
  /\.key$/i,                         // TLS 私钥
  /\.(p12|pfx|jks|keystore)$/i,      // 证书库
  /^secrets?\.(json|ya?ml|toml|env)$/i,
];

const CREDENTIAL_TEMPLATE_PATTERN = /^\.env\.(example|sample|template)$/i;

/** 给报错信息用的名单说明：只列最常见的几类，避免错误提示随规则增长而变长 */
const CREDENTIAL_EXAMPLES = ".env / .npmrc / *.pem / *.key / id_rsa / .git-credentials";

export function isCredentialFile(filePath: string): boolean {
  const name = basename(filePath);
  if (CREDENTIAL_TEMPLATE_PATTERN.test(name)) {
    return false;
  }
  return CREDENTIAL_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * @throws 命中凭据文件时抛出可读错误
 *
 * 除了看**词法**文件名，还会解析真实路径再判一次：
 * `read_file("notes.txt")` 里的 `notes.txt` 可能是指向 `.env` 的符号链接，
 * 词法上看完全无害，实际读到的却是凭据。只判 basename 等于把 symlink 当成免检通道。
 */
export function assertNotCredentialFile(filePath: string, workspaceRoot: string): void {
  const realPath = realpathOrNull(filePath);
  const hit = isCredentialFile(filePath)
    ? filePath
    : realPath !== null && isCredentialFile(realPath)
      ? realPath
      : null;

  if (hit === null) {
    return;
  }

  const viaLink =
    hit === filePath
      ? ""
      : `（经由符号链接 ${relative(workspaceRoot, filePath) || filePath} 指向）`;
  throw new Error(
    `Refusing to access credential file: ${relative(workspaceRoot, hit) || hit}${viaLink}. ` +
      `凭据类文件（${CREDENTIAL_EXAMPLES}）默认禁止读写；如确需处理，请先向用户说明并取得同意。`,
  );
}

/** 片段内部再按这些字符切开：`--file=.env`、`config/.env` 都要能命中 */
const FRAGMENT_INNER_SPLIT = /[=:\\/]+/;
/** 片段两端的通配符：`del .env*`、`rm *.pem` 动的仍是凭据文件 */
const EDGE_GLOB = /^[*?]+|[*?]+$/g;

/**
 * 片段是否指向凭据文件；命中时返回用于报错的名字。
 *
 * 先按原名判定，再剥掉两端的通配符重判：`del .env*`、`rm *.pem`
 * 在 shell 展开后删除的正是凭据文件，而 `.env*` 这个名字本身
 * 不匹配任何一条凭据规则——不剥通配符就等于给删除留了后门。
 */
function credentialHit(piece: string): string | null {
  if (piece === "") {
    return null;
  }
  if (isCredentialFile(piece)) {
    return piece;
  }
  const stripped = piece.replace(EDGE_GLOB, "");
  if (stripped !== "" && stripped !== piece && isCredentialFile(stripped)) {
    return stripped;
  }
  return null;
}

/**
 * 找出命令里提到的凭据类文件。
 *
 * 做法上刻意"宁可多报"：先用 {@link tokenizeCommand} 按 shell 词法切词
 * （去引号、按需反转义），再按 `= : \ /` 切开逐段判定。
 * 用词法切分而不是直接按字符切，是因为 `.e"nv"`、`.e'nv'` 这类拼接
 * 在 shell 里都等于 `.env`——按引号切会把它拆成 `.e` 与 `nv` 两段，正好漏掉。
 *
 * 这样 `cat .env`、`cat ./config/.env`、`--file=.env`、`grep x .env`、
 * `.e"nv"`、`del .env*` 都能命中，而 `dotenv`、`foo.env` 这类同形名字不会误伤
 * （模板文件 .env.example 由 isCredentialFile 排除）。
 *
 * 静态检查拦不住 `node -e "..."` 之类的构造，这里只是第一道闸，
 * 最终防线仍是执行前的用户审批。
 */
export function findCredentialMentions(command: string): string[] {
  const hits = new Set<string>();

  // 词法切分负责去引号/反转义；再按元字符切一次拿到候选片段
  for (const token of tokenizeCommand(command)) {
    for (const piece of token.split(FRAGMENT_INNER_SPLIT)) {
      const hit = credentialHit(piece);
      if (hit !== null) {
        hits.add(hit);
      }
    }
  }

  return [...hits];
}

/**
 * 指向工作区之外的「家目录 / 系统目录」变量。
 *
 * 只列与"用户主目录"同义的变量：它们的值一定在工作区之外，
 * 而 `%PATH%` 这类可能只是拼在输出里的变量不在此列（误伤面太大）。
 * `$HOME` / `${HOME}` / `$env:HOME`（PowerShell）/ `%APPDATA%`（cmd）都是同一类写法。
 */
const HOME_ENV_VARS =
  "HOME|USERPROFILE|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR";
const HOME_REFERENCE_PATTERN = new RegExp(
  [
    `\\$\\{?(?:${HOME_ENV_VARS})\\}?`, // $HOME / ${HOME} / $APPDATA（PowerShell 也认）
    `\\$env:(?:${HOME_ENV_VARS})`, // PowerShell：$env:APPDATA
    `%(?:${HOME_ENV_VARS})%`, // cmd：%APPDATA%
  ].join("|"),
  "i",
);

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

/**
 * Windows 盘符相对路径：`C:secret.txt`（相对「C 盘的当前目录」）。
 *
 * 它不是以 `C:\` 开头的绝对路径，所以绝对路径正则漏掉了它；但在 cmd 里
 * `C:secret.txt` 会真的打开 C 盘上的文件。这里只在 Windows 上启用，
 * 并额外要求该盘确实存在——不存在的盘读不到任何东西，放行不会造成逃逸。
 */
const WINDOWS_DRIVE_RELATIVE =
  /(?:^|[\s=:;|&<>("'`])([a-zA-Z]:(?![/\\])[^\s"']*)/g;

/**
 * Windows 当前盘根相对路径：`\Windows\win.ini`。
 *
 * 同样不是 `\\server\share` 那种 UNC，绝对路径正则也漏掉了它；
 * 但它相对的是当前盘根，读写都落在工作区之外。
 *
 * 首段要求至少两个字符：`\d`、`\n` 这类正则转义不该被当成路径
 * （`grep -P "\d+"` 里的 `\d+` 也不会命中，因为 `+` 不在名字字符集内）。
 */
const WINDOWS_ROOT_RELATIVE = /^\\[A-Za-z0-9_.$-]{2,}(?:\\[^"'`]*)?$/;

/** @returns 该盘符在当前机器上是否真实存在 */
function isExistingWindowsDrive(letter: string): boolean {
  try {
    return existsSync(`${letter.toUpperCase()}:\\`);
  } catch {
    return false;
  }
}

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
  const tokens = tokenizeCommand(command);
  for (const token of tokens) {
    if (token.startsWith("~")) {
      candidates.add(token);
      continue;
    }
    if (process.platform === "win32" && WINDOWS_ROOT_RELATIVE.test(token)) {
      // 当前盘根相对路径（\Windows\win.ini）：UNC 的 `\\server\share` 不在其中
      candidates.add(token);
      continue;
    }
    if (TRAVERSAL_IN_TOKEN.test(token)) {
      candidates.add(token);
    }
  }

  // 3) Windows 盘符相对路径（C:secret.txt）：按整条命令扫，
  //    这样写在字符串内部拼接出来的形态也逃不掉
  if (process.platform === "win32") {
    for (const match of scanned.matchAll(WINDOWS_DRIVE_RELATIVE)) {
      const value = match[1];
      if (isExistingWindowsDrive(value[0])) {
        candidates.add(value);
      }
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
        `凭据类文件（${CREDENTIAL_EXAMPLES}）默认禁止读写；` +
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
