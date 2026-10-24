/**
 * 工具输出的轻量高亮。
 *
 * 为什么自己写而不是引一个高亮库：客户端只渲染**工具输出**（文件片段、
 * JSON、命令输出），不是编辑器；一个能把 200KB diff 也照亮的通用库会带来
 * 几百 KB 依赖与一次不必要的解析。这里的规则只有"字符串 / 注释 / 数字 /
 * 关键字"四类，恰好够把一眼扫读的形状分出来。
 *
 * 纯函数、不碰 DOM：组件只负责把 token 摆成 `<span>`，因此规则可以单测。
 */

export type CodeLanguage =
  | "json"
  | "ts"
  | "js"
  | "css"
  | "html"
  | "python"
  | "shell"
  | "text";

export type TokenKind = "plain" | "key" | "string" | "number" | "keyword" | "comment" | "tag";

export type CodeToken = { text: string; kind: TokenKind };

/** 超过这个长度就不高亮：一次展开 200KB 日志时，扫一遍正则比渲染本身更贵 */
export const MAX_HIGHLIGHT_CHARS = 60_000;

const TS_KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "keyof",
  "let",
  "namespace",
  "new",
  "null",
  "of",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "unknown",
  "var",
  "void",
  "while",
  "yield",
]);

const PYTHON_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "False",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "None",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "True",
  "try",
  "while",
  "with",
  "yield",
]);

const SHELL_KEYWORDS = new Set([
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "export",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "local",
  "return",
  "then",
  "until",
  "while",
]);

const CSS_KEYWORDS = new Set(["@media", "@import", "@keyframes", "@font-face", "@supports"]);

/** 扩展名 → 语言。认不出的一律 text：不猜比猜错更诚实 */
export function languageOfPath(path: string | null | undefined): CodeLanguage {
  if (!path) {
    return "text";
  }
  const match = /\.([A-Za-z0-9]+)$/.exec(path.trim());
  const ext = match?.[1]?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "ts";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "js";
    case "json":
    case "jsonc":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "xml":
    case "svg":
    case "vue":
      return "html";
    case "py":
      return "python";
    case "sh":
    case "bash":
    case "zsh":
    case "ps1":
      return "shell";
    default:
      return "text";
  }
}

/**
 * 这个工具的输出该按什么语言高亮。
 *
 * 只有"读文件"的输出真的有语言：grep / list_dir / bash 的输出是若干行
 * 不同来源的文本，硬套语法色只会让每一行颜色乱跳。
 */
export function languageOfTool(name: string, args: string | undefined): CodeLanguage {
  if (name !== "read_file" && name !== "write_file") {
    return "text";
  }
  return languageOfPath(pathFromArgs(args));
}

/** 从工具参数里取 path（参数是 JSON 字符串；坏 JSON 就当作没有路径） */
function pathFromArgs(args: string | undefined): string | null {
  if (!args) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const path = (parsed as { path?: unknown }).path;
      return typeof path === "string" ? path : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 把一段代码切成 token。
 *
 * 规则按"先长后短"匹配：注释与字符串必须比关键字先试，否则 `// http://`
 * 里的 `http` 会被当成标识符，整行颜色都会错位。
 */
export function highlight(code: string, language: CodeLanguage): CodeToken[] {
  if (language === "text" || code.length === 0) {
    return code.length > 0 ? [{ text: code, kind: "plain" }] : [];
  }
  const input = code.length > MAX_HIGHLIGHT_CHARS ? code.slice(0, MAX_HIGHLIGHT_CHARS) : code;
  const rest = code.length > MAX_HIGHLIGHT_CHARS ? code.slice(MAX_HIGHLIGHT_CHARS) : "";
  const tokens: CodeToken[] = [];
  let index = 0;

  const push = (text: string, kind: TokenKind = "plain"): void => {
    if (text.length === 0) {
      return;
    }
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) {
      last.text += text;
    } else {
      tokens.push({ text, kind });
    }
  };

  while (index < input.length) {
    // 1) 注释
    const comment = matchComment(input, index, language);
    if (comment) {
      push(comment, "comment");
      index += comment.length;
      continue;
    }

    // 2) 字符串
    const string = matchString(input, index, language);
    if (string) {
      // JSON 的键看起来和字符串一样，靠"后面跟冒号"区分
      push(string, language === "json" ? jsonKind(input, index + string.length) : "string");
      index += string.length;
      continue;
    }

    // 3) 数字
    const number = matchAt(NUMBER_PATTERN, input, index);
    if (number && /\d/.test(number)) {
      push(number, "number");
      index += number.length;
      continue;
    }

    // 4) HTML 标签
    if (language === "html") {
      const tag = matchAt(HTML_TAG_PATTERN, input, index);
      if (tag) {
        push(tag, "tag");
        index += tag.length;
        continue;
      }
    }

    // 5) 关键字 / 普通标识符
    const word = matchAt(WORD_PATTERN, input, index);
    if (word) {
      push(word, keywordKind(word, language));
      index += word.length;
      continue;
    }

    push(input[index] ?? "", "plain");
    index += 1;
  }

  if (rest.length > 0) {
    push(rest, "plain");
  }
  return tokens;
}

/*
 * 粘性正则（`y`）而不是"切出剩余串再从头匹配"。
 *
 * 后者写起来更直白，但每一步都要复制一遍剩余内容：60KB 的文件会退化成
 * O(n²) 的拷贝，一次展开工具输出就能卡住主线程——而这里本来是"比渲染便宜"
 * 的那个版本。`lastIndex` 是共享状态，但全部调用都在同一个同步循环里。
 */
const NUMBER_PATTERN = /-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
const HTML_TAG_PATTERN = /<\/?[A-Za-z][\w:-]*/y;
const WORD_PATTERN = /[A-Za-z_$@][\w$@-]*/y;
const TEMPLATE_PATTERN = /`(?:\\[\s\S]|[^`\\])*`?/y;
const BLOCK_COMMENT_PATTERN = /\/\*[\s\S]*?(?:\*\/|$)/y;
const LINE_COMMENT_PATTERN = /\/\/[^\n]*/y;
const HASH_COMMENT_PATTERN = /#[^\n]*/y;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/y;

/** 只在 `index` 位置匹配：`y` 保证不会"跳过一点也算命中" */
function matchAt(pattern: RegExp, input: string, index: number): string | null {
  pattern.lastIndex = index;
  const match = pattern.exec(input);
  return match ? match[0] : null;
}

function keywordKind(word: string, language: CodeLanguage): TokenKind {
  switch (language) {
    case "ts":
    case "js":
      return TS_KEYWORDS.has(word) ? "keyword" : "plain";
    case "python":
      return PYTHON_KEYWORDS.has(word) ? "keyword" : "plain";
    case "shell":
      return SHELL_KEYWORDS.has(word) ? "keyword" : "plain";
    case "css":
      return CSS_KEYWORDS.has(word) ? "keyword" : "plain";
    case "json":
      return word === "true" || word === "false" || word === "null" ? "keyword" : "plain";
    default:
      return "plain";
  }
}

/** JSON 的字符串是键还是值：跳过后面的空白看下一个字符是不是 `:` */
function jsonKind(input: string, after: number): TokenKind {
  let cursor = after;
  while (cursor < input.length && /\s/.test(input[cursor] ?? "")) {
    cursor += 1;
  }
  return input[cursor] === ":" ? "key" : "string";
}

function matchComment(input: string, index: number, language: CodeLanguage): string | null {
  if (language === "html") {
    return matchAt(HTML_COMMENT_PATTERN, input, index);
  }
  if (language === "python" || language === "shell") {
    return matchAt(HASH_COMMENT_PATTERN, input, index);
  }
  if (language === "css" || language === "ts" || language === "js") {
    const block = matchAt(BLOCK_COMMENT_PATTERN, input, index);
    if (block) {
      return block;
    }
  }
  if (language === "ts" || language === "js") {
    return matchAt(LINE_COMMENT_PATTERN, input, index);
  }
  return null;
}

function matchString(input: string, index: number, language: CodeLanguage): string | null {
  if (language === "python" && (input.startsWith('"""', index) || input.startsWith("'''", index))) {
    const quote = input.slice(index, index + 3);
    const end = input.indexOf(quote, index + 3);
    return end >= 0 ? input.slice(index, end + 3) : input.slice(index);
  }
  if (language === "ts" || language === "js") {
    // 模板串允许 `\`` 转义；跨行也照收（只到闭合反引号为止）
    const template = matchAt(TEMPLATE_PATTERN, input, index);
    if (template) {
      return template;
    }
  }
  const first = input[index];
  if (first === '"' || first === "'") {
    let cursor = index + 1;
    while (cursor < input.length) {
      const char = input[cursor];
      if (char === "\\") {
        cursor += 2;
        continue;
      }
      if (char === first) {
        return input.slice(index, cursor + 1);
      }
      if (char === "\n" && language !== "python") {
        // 未闭合的普通字符串止于行尾：别把后面整段代码都涂成字符串
        return input.slice(index, cursor);
      }
      cursor += 1;
    }
    return input.slice(index);
  }
  return null;
}
