/**
 * 只读文件预览。
 *
 * 从工具输出里的可点路径、变更面板文件头的「打开」进来。它**不是文件管理器**：
 * 没有目录树、没有写入，只回答"这个文件里是什么"。因此：
 * - 路径校验全在服务端（真实路径必须落在工作区内、凭据文件拒绝、256KB 上限）；
 * - 二进制文件只说明"看不了"，不把乱码摊一屏；
 * - 截断单独标出来，不让人以为文件就到此为止；
 * - 正文带行号：路径里的 `:12` 点进来直接滚到第 12 行并高亮，否则行号只是
 *   一列装饰，"定位到具体行"仍然要靠肉眼数。
 *
 * 画法与变更面板一致：绝对定位盖在主列的会话层上，侧栏与输入区仍在场。
 */

import { useActions, useClient } from "../store";
import { formatBytes } from "../format";
import { splitLines, languageOfPath } from "../highlight";
import { CodeLines } from "./CodeLines";
import { Icon } from "./Icon";

export function FilePreview(): React.ReactElement | null {
  const state = useClient();
  if (!state.ui.file) {
    return null;
  }
  return <FileDialog path={state.ui.file.path} line={state.ui.file.line} />;
}

function FileDialog({ path, line }: { path: string; line: number | null }): React.ReactElement {
  const state = useClient();
  const actions = useActions();
  const content = state.file;
  const language = languageOfPath(content?.path ?? path);
  // 目标行是否真的在这份正文里：越界时宁可不滚，也不假装定位成功
  const lineCount = content && !content.binary ? splitLines(content.content).length : 0;
  const targetLine = line !== null && line >= 1 && line <= lineCount ? line : null;
  const missed = line !== null && content !== null && !content.binary && targetLine === null;

  return (
    <div className="diff-panel" role="dialog" aria-label="文件预览">
      <div className="diff-card">
        <div className="modal-head">
          <Icon name="copy" color="var(--Client-accent-text)" />
          <code className="diff-file-path" style={{ flex: 1 }} title={path}>
            {content?.path ?? path}
          </code>
          {content ? (
            <span className="file-meta">
              {formatBytes(content.size)}
              {content.truncated ? " · 只显示开头" : ""}
              {line !== null ? ` · 第 ${line} 行` : ""}
            </span>
          ) : null}
          <button
            className="btn btn-ghost"
            title="关闭（Esc）"
            style={{ padding: "3px 8px" }}
            onClick={() => actions.closeFile()}
          >
            <Icon name="x" size={12} />
          </button>
        </div>

        <div className="modal-body">
          {state.fileLoading ? <div className="empty-hint">正在读取文件…</div> : null}
          {state.fileError ? (
            <div className="bar bar-err" style={{ margin: 0 }}>
              <Icon name="alert" />
              {state.fileError}
            </div>
          ) : null}

          {content?.binary ? (
            <div className="bar bar-warn" style={{ margin: 0 }}>
              <Icon name="alert" />
              这是一个二进制文件，无法按文本预览
            </div>
          ) : null}

          {missed ? (
            <div className="bar bar-warn" style={{ margin: 0 }}>
              <Icon name="alert" />
              {`第 ${line} 行不在预览范围内（文件可能已变化，或只显示了开头）`}
            </div>
          ) : null}

          {content && !content.binary ? (
            <CodeLines
              text={content.content}
              language={language}
              actions={actions}
              targetLine={targetLine}
              className="file-body"
            />
          ) : null}

          {content?.truncated ? (
            <div className="bar bar-warn" style={{ margin: 0 }}>
              <Icon name="alert" />
              {`文件较大，这里只显示前 ${formatBytes(256 * 1024)}；完整内容请在本地打开`}
            </div>
          ) : null}
        </div>

        <div className="modal-foot">
          <span className="file-meta">只读预览 · 不会修改文件</span>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={() => actions.closeFile()}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
