/**
 * 把工具输出里的文件路径切成可点片段。
 *
 * 工具输出（grep 命中、报错栈、`ls` 结果）里最常被追问的一句话是
 * "这个文件在哪、那一行是什么"。让路径可点，等于把"复制路径 → 去找 →
 * 打开"三步压成一步。
 *
 * 纯函数：点不点得开由动作层决定，这里只回答"哪一段像路径"。
 */

export type TextSegment =
  | { kind: "text"; text: string }
  | {
      kind: "path";
      /** 原始文本（含 `:line` 后缀），渲染时原样显示 */
      text: string;
      /** 去掉行号后的路径 */
      path: string;
      line: number | null;
      column: number | null;
    };

/** 形如 `src/a.ts`、`D:\ws\a.ts`、`/repo/a.ts`、`a.ts` */
const BARE_FILE = /^(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?[^\s"'<>|*?]+$/;

/**
 * 这段非空白文本是不是路径。
 *
 * 判定刻意保守：宁可少标一个，也不要把 `--flag=value`、`12:30`、
 * `https://…` 变成可点链接——点开一个 404 面板比不点更烦人。
 */
export function parsePathText(raw: string): TextSegment | null {
  let text = raw;
  // 首尾的括号属于句子，不属于路径：`(src/a.ts)` / `[src/a.ts]`
  while (text.length > 0 && /[([{<]/.test(text[0]!)) {
    text = text.slice(1);
  }
  // 尾部的标点属于句子，不属于路径：`src/a.ts:12:` / `(src/a.ts),`
  while (text.length > 0 && /[.,;:)\]}>]/.test(text[text.length - 1]!)) {
    text = text.slice(0, -1);
  }
  if (text.length === 0) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith("mailto:")) {
    return null;
  }

  let path = text;
  let line: number | null = null;
  let column: number | null = null;
  const located = /^(.*?):(\d+)(?::(\d+))?$/.exec(text);
  if (located && located[1]!.length > 0) {
    path = located[1]!;
    line = Number(located[2]);
    column = located[3] === undefined ? null : Number(located[3]);
  }

  if (!looksLikePath(path)) {
    return null;
  }
  // `text` 保留**原始片段**：按钮上少一个括号或冒号，改动的是工具输出的原文，
  // 而这段文本是要复核的（grep 命中、报错栈）。去掉的只是判定用的外壳。
  return { kind: "path", text: raw, path, line, column };
}

function looksLikePath(path: string): boolean {
  if (path.length > 512 || path.includes("=")) {
    return false;
  }
  if (!BARE_FILE.test(path)) {
    return false;
  }
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(path);
  const posixAbsolute = path.startsWith("/");
  const hasSeparator = /[\\/]/.test(path);
  const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(path);
  if (windowsAbsolute || posixAbsolute) {
    return hasExtension || hasSeparator;
  }
  if (path.startsWith("./") || path.startsWith("../")) {
    return true;
  }
  // 只有带分隔符或带扩展名的才像文件；`foo`、`--bar` 一律不点
  return (hasSeparator && hasExtension) || /^[\w@-][\w.@-]*\.[A-Za-z0-9]{1,8}$/.test(path);
}

/**
 * 按非空白片段切分；命中路径的片段变成可点段，其余原样返回。
 *
 * 保留原文的空白与换行：工具输出是 pre，重排会改变它的语义。
 */
export function linkifyPaths(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const run = /(\s+)|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = run.exec(text)) !== null) {
    const chunk = match[0];
    if (match[1] !== undefined) {
      segments.push({ kind: "text", text: chunk });
      continue;
    }
    const parsed = parsePathText(chunk);
    if (parsed) {
      segments.push(parsed);
    } else {
      segments.push({ kind: "text", text: chunk });
    }
  }
  return segments;
}
