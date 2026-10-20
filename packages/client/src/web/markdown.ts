/**
 * 极小的 Markdown 渲染器。
 *
 * 只支持模型真正会用到的几种结构（段落、列表、标题、围栏代码块、
 * 行内代码与粗体）。理由有两条：
 *
 * 1. **安全**：全程用 DOM 节点拼装，不碰 `innerHTML`。模型输出是不可信文本，
 *    一个 `format: "html"` 之类的开关就等于把 XSS 交给它决定。
 * 2. **够用**：渲染得太全反而不一致——终端那边只显示纯文本，
 *    网页上多出来的表格与脚注会让两端"同一段话"长得不像。
 */

const FENCE = /^```([\w+-]*)\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const LIST_ITEM = /^[-*]\s+(.*)$/;

export function renderMarkdown(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = text.split("\n");

  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }
    const node = document.createElement("p");
    node.className = "md-p";
    appendInline(node, paragraph.join("\n"));
    fragment.appendChild(node);
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
      const pre = document.createElement("pre");
      const block = document.createElement("code");
      block.textContent = code.join("\n");
      if (fence[1]) {
        pre.dataset.lang = fence[1];
      }
      pre.appendChild(block);
      fragment.appendChild(pre);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const node = document.createElement("h4");
      appendInline(node, heading[2]!);
      fragment.appendChild(node);
      index += 1;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flushParagraph();
      const list = document.createElement("ul");
      while (index < lines.length) {
        const item = LIST_ITEM.exec(lines[index]!);
        if (!item) {
          break;
        }
        const li = document.createElement("li");
        appendInline(li, item[1]!);
        list.appendChild(li);
        index += 1;
      }
      fragment.appendChild(list);
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
  return fragment;
}

/**
 * 行内语法：`` `code` `` 与 `**bold**`。
 *
 * 换行保留成 `<br>`：模型常在列表之外用硬换行分点，全折成空格会挤成一坨。
 */
function appendInline(parent: Node, text: string): void {
  let rest = text;
  while (rest.length > 0) {
    const code = rest.indexOf("`");
    const bold = rest.indexOf("**");
    const next = [code, bold].filter((position) => position >= 0);
    if (next.length === 0) {
      appendText(parent, rest);
      return;
    }
    const position = Math.min(...next);
    if (position > 0) {
      appendText(parent, rest.slice(0, position));
      rest = rest.slice(position);
      continue;
    }
    if (code === 0) {
      const end = rest.indexOf("`", 1);
      if (end < 0) {
        appendText(parent, rest);
        return;
      }
      const node = document.createElement("code");
      node.textContent = rest.slice(1, end);
      parent.appendChild(node);
      rest = rest.slice(end + 1);
      continue;
    }
    // 粗体
    const end = rest.indexOf("**", 2);
    if (end < 0) {
      appendText(parent, rest);
      return;
    }
    const node = document.createElement("strong");
    node.textContent = rest.slice(2, end);
    parent.appendChild(node);
    rest = rest.slice(end + 2);
  }
}

function appendText(parent: Node, text: string): void {
  const parts = text.split("\n");
  parts.forEach((part, position) => {
    if (position > 0) {
      parent.appendChild(document.createElement("br"));
    }
    if (part.length > 0) {
      parent.appendChild(document.createTextNode(part));
    }
  });
}
