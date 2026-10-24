/**
 * 带行号的代码块（文件预览用）。
 *
 * 单独的组件而不是给 `CodeBlock` 加开关：工具输出里 `grep` / `bash` 的行没有
 * 稳定的“第几行”语义，套上行号只会误导；文件预览则相反——行号是定位的
 * 唯一依据，`src/a.ts:12` 点进来要能直接看到第 12 行。
 *
 * 三条约束：
 * - **不改变原文**：每行只是 `highlightLines` 拆出来的 token，不补空格、不删字符；
 * - **行号不参与复制**：`user-select: none` + `aria-hidden`，复制正文不会带上一列数字；
 * - **定位不猜**：目标行真的存在才滚动与高亮（越界由调用方提示）。
 */

import { useEffect, useRef } from "react";
import type { Actions } from "../actions";
import { highlightLines, type CodeLanguage } from "../highlight";
import { LinkifiedText } from "./CodeBlock";

export type CodeLinesProps = {
  text: string;
  language: CodeLanguage;
  actions: Actions;
  /** 产出这段文本的 Run：预览隔离目录里的文件时要靠它寻址 */
  runId?: string;
  /** 打开时定位到的行（来自路径里的 `:12`）；null / 越界由调用方先判掉 */
  targetLine?: number | null;
  className?: string;
};

export function CodeLines({
  text,
  language,
  actions,
  runId,
  targetLine = null,
  className,
}: CodeLinesProps): React.ReactElement {
  const lines = highlightLines(text, language);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 打开就滚到目标行：先渲染再滚，`querySelector` 拿到的才是这一版的行
  useEffect(() => {
    if (targetLine === null) {
      return;
    }
    const node = wrapRef.current?.querySelector<HTMLElement>(`[data-line="${targetLine}"]`);
    node?.scrollIntoView?.({ block: "center" });
  }, [targetLine, text]);

  return (
    <div className={`code-lines${className ? ` ${className}` : ""}`} ref={wrapRef}>
      {lines.map((line) => (
        <div
          key={line.number}
          data-line={line.number}
          className={`code-line${line.number === targetLine ? " is-target" : ""}`}
        >
          <span className="code-no" aria-hidden="true">
            {line.number}
          </span>
          <code className="code-text">
            {language === "text" ? (
              <LinkifiedText
                text={line.tokens.map((token) => token.text).join("")}
                actions={actions}
                runId={runId}
              />
            ) : (
              line.tokens.map((token, index) => (
                <span key={index} className={`tok tok-${token.kind}`}>
                  {token.text}
                </span>
              ))
            )}
          </code>
        </div>
      ))}
    </div>
  );
}
