/**
 * 只读文件预览。
 *
 * 从工具输出里的可点路径、变更面板文件头的「打开」进来。它**不是文件管理器**：
 * 没有目录树、没有写入，只回答"这个文件里是什么"。因此：
 * - 路径校验全在服务端（真实路径必须落在工作区内、凭据文件拒绝、256KB 上限）；
 * - 二进制文件只说明"看不了"，不把乱码摊一屏；
 * - 截断单独标出来，不让人以为文件就到此为止。
 *
 * 画法与变更面板一致：绝对定位盖在主列的会话层上，侧栏与输入区仍在场。
 */

import { useActions, useClient } from "../store";
import { formatBytes } from "../format";
import { languageOfPath } from "../highlight";
import { CodeBlock } from "./CodeBlock";
import { Icon } from "./Icon";

export function FilePreview(): React.ReactElement | null {
  const state = useClient();
  if (!state.ui.file) {
    return null;
  }
  return <FileDialog path={state.ui.file.path} />;
}

function FileDialog({ path }: { path: string }): React.ReactElement {
  const state = useClient();
  const actions = useActions();
  const content = state.file;
  const language = languageOfPath(content?.path ?? path);

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
          {state.fileLoading ? <div className="empty-hint">正在读取文件……</div> : null}
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

          {content && !content.binary ? (
            <CodeBlock
              text={content.content}
              language={language}
              actions={actions}
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
