/**
 * 路径模式匹配：glob 编译与 gitignore 语义。
 *
 * `list_files` / `glob` / `grep` 三个工具共用同一份实现，
 * 避免各自的过滤规则不一致（"列出来的和搜出来的不是一套文件"）。
 *
 * 支持范围（刻意保持小而可预测）：
 * - `*` 匹配单层内任意字符，`?` 匹配单层一个字符，`**` 跨层；
 * - `{a,b}` 单层花括号枚举；
 * - gitignore 语法：`#` 注释、`!` 取反、结尾 `/` 仅目录、
 *   含 `/` 视为根相对、不含 `/` 匹配任意层级上的同名条目。
 *
 * 不支持：字符类 `[a-z]`、反斜杠转义、嵌套花括号、`**` 的其它位置变体。
 */

/** 编译后的 glob 缓存，避免同一模式反复编译 */
const globCache = new Map<string, RegExp>();

/** 把 glob 模式编译为正则（针对以 `/` 分隔的相对路径） */
export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) {
    return cached;
  }

  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        // `**/` 可以匹配零层目录，因此后面紧跟斜杠时整体变成可选前缀
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    if (char === "{") {
      const end = pattern.indexOf("}", index);
      if (end > index) {
        const options = pattern
          .slice(index + 1, end)
          .split(",")
          .map((option) => escapeRegExp(option));
        source += `(?:${options.join("|")})`;
        index = end;
        continue;
      }
    }

    source += escapeRegExp(char);
  }

  const regexp = new RegExp(`^${source}$`);
  globCache.set(pattern, regexp);
  return regexp;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 判断相对路径是否匹配 glob。
 * 不含 `/` 的模式匹配任意层级上的名字（`*.ts` 等价于 `**\/*.ts`）。
 */
export function matchesGlob(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const regexp = globToRegExp(pattern);
  if (pattern.includes("/")) {
    return regexp.test(normalized) || regexp.test(normalized.replace(/^\//, ""));
  }
  return normalized
    .split("/")
    .some((segment) => globToRegExp(pattern).test(segment));
}

/** 默认忽略项：依赖目录与构建产物，避免把上下文烧在无关文件上 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".cache/",
  ".turbo/",
  ".pnpm-store/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "target/",
  ".idea/",
  ".vscode/",
];

export type IgnoreMatcher = (relativePath: string, isDirectory: boolean) => boolean;

type IgnoreRule = {
  negated: boolean;
  directoryOnly: boolean;
  /** 含 `/` 的模式按根相对匹配，否则按任意层级上的名字匹配 */
  anchored: boolean;
  pattern: string;
};

/** 解析 gitignore 风格的文本为规则列表 */
export function parseIgnorePatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * 构造忽略判定函数（gitignore 语义，后者覆盖前者）。
 * @param patterns 规则文本行（可来自 .gitignore 与内置默认项）
 */
export function createIgnoreMatcher(patterns: readonly string[]): IgnoreMatcher {
  const rules: IgnoreRule[] = patterns
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!");
      const body = negated ? line.slice(1) : line;
      const directoryOnly = body.endsWith("/");
      const withoutTrailingSlash = directoryOnly ? body.slice(0, -1) : body;
      // 含 `/` 视为根相对；开头的 `/` 只是"从根开始"的标记，编译前去掉
      const anchored = withoutTrailingSlash.includes("/");
      const pattern = withoutTrailingSlash.startsWith("/")
        ? withoutTrailingSlash.slice(1)
        : withoutTrailingSlash;
      return { negated, directoryOnly, anchored, pattern };
    });

  return (relativePath: string, isDirectory: boolean): boolean => {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\//, "");
    let ignored = false;

    for (const rule of rules) {
      if (rule.directoryOnly && !isDirectory) {
        continue;
      }
      if (!matchesIgnoreRule(normalized, rule)) {
        continue;
      }
      ignored = !rule.negated;
    }

    return ignored;
  };
}

function matchesIgnoreRule(normalized: string, rule: IgnoreRule): boolean {
  const regexp = globToRegExp(rule.pattern);
  if (rule.anchored) {
    return regexp.test(normalized);
  }
  return normalized.split("/").some((segment) => regexp.test(segment));
}
