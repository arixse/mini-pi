/**
 * 审批卡里那段参数预览。
 *
 * 为什么在服务端做而不是把 `arguments` 原样下发：`write_file` 的 content
 * 可能是几十万字符，一条审批请求就够把事件流撑爆；而前端拿到整段内容
 * 也只显示前几行。这里裁剪一次，前端只负责排版。
 *
 * 与 `describeToolCallLines` 的分工：摘要回答"这是什么事"（两端必须一字不差），
 * 预览回答"具体参数长什么样"（终端不需要、网页需要）。
 */

const DEFAULT_MAX_CHARS = 1_200;
const DEFAULT_MAX_LINES = 14;

function clip(text: string, maxChars: number, maxLines: number): string {
  const lines = text.split("\n");
  const kept = lines.slice(0, maxLines).join("\n");
  const truncatedByLines = lines.length > maxLines;
  const clipped =
    kept.length > maxChars ? `${kept.slice(0, maxChars)}…` : kept;
  const suffix = truncatedByLines
    ? `\n…（还有 ${lines.length - maxLines} 行）`
    : "";
  return `${clipped}${suffix}`;
}

/** 多行内容的"行数"提示：网页上显示 `content: …（+182 行）` 比铺 182 行有用 */
function describeBlock(label: string, value: unknown): string {
  if (typeof value !== "string") {
    return `${label}: ${JSON.stringify(value) ?? ""}`;
  }
  const lines = value.split("\n");
  if (lines.length <= 1) {
    return `${label}: ${value}`;
  }
  return `${label}: …（${lines.length} 行）`;
}

export type PreviewOptions = { maxChars?: number; maxLines?: number };

/**
 * 生成参数预览。
 *
 * 分工按"用户点允许前最需要看到什么"：
 * - `bash` / `verify_command`：完整命令（就是它要执行的东西）
 * - `write_file`：路径 + 内容规模（内容本身看不完，看规模才判断得出影响）
 * - `edit_file`：路径 + 新旧片段的开头
 * - 其余：键值对 / JSON
 */
export function previewToolArgs(
  call: { name: string; arguments?: Record<string, unknown> },
  options: PreviewOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const args = call.arguments ?? {};

  switch (call.name) {
    case "bash":
    case "verify_command":
      return clip(String(args.command ?? ""), maxChars, maxLines);
    case "write_file":
      return clip(
        [describeBlock("path", args.path), describeBlock("content", args.content)]
          .join("\n"),
        maxChars,
        maxLines,
      );
    case "edit_file":
      return clip(
        [
          describeBlock("path", args.path),
          describeBlock("old", args.oldText ?? args.old_string ?? args.search),
          describeBlock("new", args.newText ?? args.new_string ?? args.replace),
        ].join("\n"),
        maxChars,
        maxLines,
      );
    case "read_file":
    case "list_files":
    case "glob":
    case "grep":
      return clip(
        Object.entries(args)
          .map(([key, value]) => `${key}: ${oneLineValue(value)}`)
          .join("\n") || "(无参数)",
        maxChars,
        maxLines,
      );
    default: {
      if (Object.keys(args).length === 0) {
        return "(无参数)";
      }
      let pretty: string;
      try {
        pretty = JSON.stringify(args, null, 2) ?? "";
      } catch {
        pretty = String(args);
      }
      return clip(pretty, maxChars, maxLines);
    }
  }
}

function oneLineValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}
