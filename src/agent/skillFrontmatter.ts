/**
 * SKILL.md frontmatter 的解析。
 *
 * **这不是完整 YAML 解析器**，只覆盖 skill 文件的实际形态：
 * - `---` 开头的 frontmatter 块（容忍前置 BOM 与 CRLF）；
 * - `name:` / `description:` 的单行值；
 * - `>` / `|` 块标量，以及后续缩进的续行（折叠语义用空格近似——
 *   对展示用的描述而言，空白归一比保留换行更可读）；
 * - 成对包裹的引号（`"..."` / `'...'`）会被剥掉：外部生态的 SKILL.md
 *   （如 WorkBuddy 的）普遍带引号，不剥的话引号会原样进描述文本，
 *   `/load "name"` 也会因为带着引号而匹配不上。
 *
 * 刻意不做：嵌套结构、锚点、行尾注释（描述里可能出现 `#`，
 * 一刀切当注释去掉反而丢内容）。字段名硬编码 name/description：
 * 别的字段对"列表展示 + 按名加载"没有用处。
 */

export type SkillFrontmatter = {
  name: string;
  description: string;
};

/** frontmatter 块：文件开头（允许 BOM）的 `---` 到下一个 `---` */
const FRONTMATTER_RE = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---/;

/**
 * 解析 frontmatter。
 *
 * 没有 `name` 时返回 null：名字是 `/load` 与列表展示的键，
 * 缺了它这个 skill 无法被引用（调用方负责告警，不静默）。
 */
export function parseFrontmatter(content: string): SkillFrontmatter | null {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return null;
  }

  const name = readField(match[1], "name");
  if (!name) {
    return null;
  }

  return {
    name,
    description: readField(match[1], "description") ?? "",
  };
}

/**
 * 从 frontmatter 块里读一个字段的值。
 *
 * 续行规则：值以 `>` / `|` 开头（块标量），或后续行以空白开头且不像
 * `key:`，都属于这个字段。后者是 YAML 的普通多行标量（折叠）形态。
 */
function readField(block: string, key: string): string | null {
  const lines = block.split(/\r?\n/);
  const keyPattern = new RegExp(`^${key}\\s*:`);
  const start = lines.findIndex((line) => keyPattern.test(line));
  if (start < 0) {
    return null;
  }

  const rawValue = lines[start].slice(lines[start].indexOf(":") + 1).trim();
  const isBlockScalar = /^[>|]/.test(rawValue);
  const parts: string[] = isBlockScalar ? [] : [rawValue];

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // 非缩进行：字段到此结束
    if (!/^\s+\S/.test(line)) break;
    // 缩进的 `key:` 行：是下一个字段，不是续行
    if (/^\s*[\w.-]+\s*:/.test(line)) break;
    parts.push(line.trim());
  }

  const value = parts.join(" ").trim();
  return value === "" ? null : stripQuotes(value);
}

/** 剥掉成对包裹的引号；不成对则原样返回 */
function stripQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}
