/**
 * 代码 / 工具输出块。
 *
 * 两件事，都只在"看得懂"这个层面：
 * - **语法高亮**：规则在 `highlight.ts`，这里只把 token 摆成 `<span>`。
 *   工具输出原先是纯 `<pre>`，一屏 JSON 全是同一种颜色，读起来只能逐字扫；
 * - **路径可点**：输出里形如 `src/a.ts:12` 的片段变成按钮，点开只读预览。
 *   这是把"复制路径 → 去目录里找 → 打开"压成一步。
 *
 * 折叠语义：纯文本（grep / bash / ls 的输出）走路径识别；代码（read_file
 * 的正文）走高亮。两者互斥——把代码里的每个标识符也做成链接，既点不中
 * 也读不清。
 */

import type { Actions } from "../actions";
import { highlight, type CodeLanguage } from "../highlight";
import { linkifyPaths } from "../linkify";

export type CodeBlockProps = {
  text: string;
  language: CodeLanguage;
  actions: Actions;
  /** 产出这段文本的 Run：预览隔离目录里的文件时要用它寻址 */
  runId?: string;
  className?: string;
};

export function CodeBlock({
  text,
  language,
  actions,
  runId,
  className,
}: CodeBlockProps): React.ReactElement {
  if (language === "text") {
    return (
      <pre className={className}>
        <LinkifiedText text={text} actions={actions} runId={runId} />
      </pre>
    );
  }
  return (
    <pre className={className}>
      {highlight(text, language).map((token, index) => (
        <span key={index} className={`tok tok-${token.kind}`}>
          {token.text}
        </span>
      ))}
    </pre>
  );
}

/**
 * 一段文本，其中像路径的片段可点。
 *
 * 保留原文的空白与换行（它常常是 `pre` 里的内容）：只把片段换成按钮，
 * 中间不补任何字符，缩进与对齐才不会走样。
 */
export function LinkifiedText({
  text,
  actions,
  runId,
}: {
  text: string;
  actions: Actions;
  runId?: string;
}): React.ReactElement {
  return (
    <>
      {linkifyPaths(text).map((segment, index) =>
        segment.kind === "path" ? (
          <button
            key={index}
            type="button"
            className="path-link"
            title={
              segment.line === null
                ? `预览 ${segment.path}`
                : `预览 ${segment.path}（第 ${segment.line} 行）`
            }
            onClick={() => actions.openFile(segment.path, runId, segment.line ?? undefined)}
          >
            {segment.text}
          </button>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
