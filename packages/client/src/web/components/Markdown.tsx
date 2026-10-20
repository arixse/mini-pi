/**
 * Markdown 的渲染端。
 *
 * 只把 `parseMarkdown` 产出的 token 变成文本节点——**没有 `dangerouslySetInnerHTML`**，
 * 因为模型正文是不可信文本。结构判断全在 `markdown.ts`（纯函数，可测），
 * 这里不重复解析一遍。
 */

import { Fragment } from "react";
import { parseMarkdown, type MdInline } from "../markdown";

export function Markdown({ text }: { text: string }): React.ReactElement {
  return (
    <>
      {parseMarkdown(text).map((block, index) => {
        switch (block.type) {
          case "code":
            return (
              <pre key={index} data-lang={block.lang ?? undefined}>
                <code>{block.text}</code>
              </pre>
            );
          case "heading":
            return <h4 key={index}>{inline(block.content, index)}</h4>;
          case "list":
            return (
              <ul key={index}>
                {block.items.map((item, position) => (
                  <li key={position}>{inline(item, position)}</li>
                ))}
              </ul>
            );
          default:
            return (
              <p key={index} className="md-p">
                {inline(block.content, index)}
              </p>
            );
        }
      })}
    </>
  );
}

/** 行内 token → 节点；`br` 用 key 区分，其余按顺序给 key */
function inline(tokens: MdInline[], seed: number): React.ReactNode {
  return tokens.map((token, index) => {
    const key = `${seed}-${index}`;
    switch (token.type) {
      case "code":
        return <code key={key}>{token.text}</code>;
      case "strong":
        return <strong key={key}>{token.text}</strong>;
      case "br":
        return <br key={key} />;
      default:
        return <Fragment key={key}>{token.text}</Fragment>;
    }
  });
}
