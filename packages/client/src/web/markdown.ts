/**
 * 极小的 Markdown 解析：文本 → 结构。
 *
 * 只支持模型真正会用到的几种结构（段落、列表、标题、围栏代码块、
 * 行内代码与粗体）。理由有两条：
 *
 * 1. **安全**：这里只产出**数据与结构**，不产出 HTML，也不产出 DOM。
 *    模型输出是不可信文本，一个 `format: "html"` 之类的开关就等于把 XSS
 *    交给它决定；渲染交给 React（`components/Markdown.tsx`），
 *    它只会把这些 token 变成文本节点。
 * 2. **够用**：渲染得太全反而不一致——终端那边只显示纯文本，
 *    网页上多出来的表格与脚注会让两端"同一段话"长得不像。
 *
 * 分成"解析"与"渲染"两半之后，解析是纯函数，可以在 node 里直接测。
 */

const FENCE = /^```([\w+-]*)\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const LIST_ITEM = /^[-*]\s+(.*)$/;

export type MdInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; text: string }
  | { type: "br" };

export type MdBlock =
  | { type: "p"; content: MdInline[] }
  | { type: "code"; lang: string | null; text: string }
  | { type: "heading"; level: number; content: MdInline[] }
  | { type: "list"; items: MdInline[][] };

export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = text.split("\n");
  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }
    blocks.push({ type: "p", content: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index]!;

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      index += 1;
      blocks.push({
        type: "code",
        lang: fence[1] && fence[1].length > 0 ? fence[1]! : null,
        text: code.join("\n"),
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        content: parseInline(heading[2]!),
      });
      index += 1;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flushParagraph();
      const items: MdInline[][] = [];
      while (index < lines.length) {
        const item = LIST_ITEM.exec(lines[index]!);
        if (!item) {
          break;
        }
        items.push(parseInline(item[1]!));
        index += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

/** 行内语法：`` `code` `` 与 `**bold**`；硬换行保留成 `br` */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let rest = text;

  while (rest.length > 0) {
    const code = rest.indexOf("`");
    const bold = rest.indexOf("**");
    const next = [code, bold].filter((position) => position >= 0);
    if (next.length === 0) {
      pushText(out, rest);
      return out;
    }
    const position = Math.min(...next);
    if (position > 0) {
      pushText(out, rest.slice(0, position));
      rest = rest.slice(position);
      continue;
    }
    if (code === 0) {
      const end = rest.indexOf("`", 1);
      if (end < 0) {
        pushText(out, rest);
        return out;
      }
      out.push({ type: "code", text: rest.slice(1, end) });
      rest = rest.slice(end + 1);
      continue;
    }
    // 粗体
    const end = rest.indexOf("**", 2);
    if (end < 0) {
      pushText(out, rest);
      return out;
    }
    out.push({ type: "strong", text: rest.slice(2, end) });
    rest = rest.slice(end + 2);
  }

  return out;
}

/**
 * 换行保留成 `br`：模型常在列表之外用硬换行分点，全折成空格会挤成一坨。
 *
 * 相邻的文本片会并回一个 token——"没闭合的 `" 这类情况会把一行切成两段，
 * 分成两个节点渲染出来还是同一句话，但节点数翻倍且不便断言。
 */
function pushText(out: MdInline[], text: string): void {
  const parts = text.split("\n");
  parts.forEach((part, position) => {
    if (position > 0) {
      out.push({ type: "br" });
    }
    if (part.length === 0) {
      return;
    }
    const last = out[out.length - 1];
    if (last && last.type === "text") {
      last.text += part;
      return;
    }
    out.push({ type: "text", text: part });
  });
}
