/**
 * 代码 / 工具输出块。
 *
 * 两件事，都只在"看得懂"这个层面：
 * - **语法高亮**：规则在 `highlight.ts`，这里只把 token 摆成 `<span>`。
 *   工具输出原先是纯 `<pre>`，一屏 JSON 全是同一种颜色，读起来只能逐字扫；
 * - **路径可点**：输出里形如 `src/a.ts:12` 的片段变成按钮，点开只读预览。
 *   这是把"复制路径 → 去目录里找 → 打开"压成一步。只对**确认存在**的路径
 *   画链接（见 `pathLinks.ts`）：点开一条只回「文件不存在」的链接更糟。
 *
 * 折叠语义：纯文本（grep / bash / ls 的输出）走路径识别；代码（read_file
 * 的正文）走高亮。两者互斥——把代码里的每个标识符也做成链接，既点不中
 * 也读不清。
 */

import { useEffect, useRef } from "react";
import type { Actions } from "../actions";
import { highlight, type CodeLanguage } from "../highlight";
import { linkifyPaths } from "../linkify";
import { pathExists, pathScopeOf } from "../pathLinks";
import { useClient } from "../store";

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
 * 一段文本，其中**确认存在**的路径可点。
 *
 * 保留原文的空白与换行（它常常是 `pre` 里的内容）：只把片段换成按钮，
 * 中间不补任何字符，缩进与对齐才不会走样。
 *
 * "确认存在"是这条规则的全文：工具输出里提到的路径不一定还在（模型先说出来
 * 再去创建、报错栈里的文件已被删掉、历史会话早过时）。点开一条只回
 * 「文件不存在」的链接比不给链接更糟，所以这里先问一句，答"在"才画（见
 * `pathLinks.ts`）。问到答案之前也是普通文本，只是没有下划线。
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
  const state = useClient();
  const scope = pathScopeOf(state, runId);
  const segments = linkifyPaths(text);
  const unknown = segments.flatMap((segment) =>
    segment.kind === "path" && pathExists(state, scope, segment.path) === null
      ? [segment.path]
      : [],
  );
  // 依赖拼出来的字符串而不是数组：每次渲染都是新数组，按引用比会无限重跑
  const unknownKey = unknown.join("\u0000");
  const latest = useRef(unknown);
  latest.current = unknown;
  useEffect(() => {
    if (unknownKey !== "") {
      actions.checkPaths(latest.current, runId ?? null);
    }
  }, [unknownKey, runId, scope.root, actions]);

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind !== "path") {
          return <span key={index}>{segment.text}</span>;
        }
        const known = pathExists(state, scope, segment.path);
        if (known !== true) {
          // 还没问到、或确认不存在：两种都是普通文本。后者补一句"为什么点不动"
          // 的说明（只在 hover 出现），否则同一屏里有的能点有的不能，看不出缘故
          return known === false ? (
            <span key={index} title={`文件不存在，无法预览：${segment.path}`}>
              {segment.text}
            </span>
          ) : (
            <span key={index}>{segment.text}</span>
          );
        }
        return (
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
        );
      })}
    </>
  );
}
