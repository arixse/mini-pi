/**
 * 时间线的条目。
 *
 * 三条来自设计稿的硬要求：
 * - 工具卡片**必须渲染参数**（第 7 条）：只写"跑了 grep"等于让用户信任一句没有证据的话
 * - 风险等级与原因由内核算好，前端只配色（第 8 条）
 * - 高危单独成块，不叠加降级理由（第 10 条）：一次列五条会把最致命的那条淹掉
 *
 * 每条都按 `revision` 指纹做 memo：条目对象是就地修改的，按引用比较的 memo
 * 会永远认为没变，于是整条时间线每次 delta 都要重画。
 */

import { memo, useEffect, useState } from "react";
import type { Actions } from "../actions";
import type { TimelineItem } from "../state";
import {
  approvalStatusText,
  describeArgs,
  noticeTone,
  toolStatusMeta,
} from "../items";
import { formatDuration, riskMeta, toolMetaLine } from "../format";
import { Icon, Dot } from "./Icon";
import { Markdown } from "./Markdown";

/** 工具输出在卡片里最多显示几行，超出给"展开全部" */
const OUTPUT_PREVIEW_LINES = 6;

export type ItemProps = {
  item: TimelineItem;
  /** `revisionOf(item)`：指纹不变就不重画这一条 */
  revision: string;
  expanded: boolean;
  onToggle: (id: string) => void;
  actions: Actions;
};

export const TimelineItemRow = memo(
  function TimelineItemRow({ item, expanded, onToggle, actions }: ItemProps): React.ReactElement {
    switch (item.kind) {
      case "user":
        return (
          <div className="row right">
            <div className="stack">
              <div className="bubble-user">
                {item.text}
                {item.queued ? (
                  <span
                    className="pill pill-slate"
                    style={{ marginLeft: 8, fontSize: "10.5px" }}
                  >
                    已入队
                  </span>
                ) : null}
              </div>
              <div className="avatar user">我</div>
            </div>
          </div>
        );

      case "assistant":
        return (
          <div className="row">
            <div className="avatar bot">
              <Icon name="sparkles" size={13} />
            </div>
            <div className="stack">
              <div className="bubble-wrap bubble-bot" style={{ width: "100%" }}>
                {item.streaming ? (
                  <>
                    {/* 流式期间按纯文本渲染：每个 delta 都跑一遍 Markdown 解析纯属浪费，
                        而且半截的 ``` 会让代码块在眼前反复跳 */}
                    <span style={{ whiteSpace: "pre-wrap" }}>{item.text}</span>
                    <span className="caret" />
                  </>
                ) : (
                  <>
                    <Markdown text={item.text} />
                    <button
                      className="copy"
                      title="复制这段回复"
                      onClick={() => void navigator.clipboard?.writeText(item.text)}
                    >
                      复制
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        );

      case "tool":
        return <ToolCard item={item} expanded={expanded} onToggle={onToggle} />;

      case "approval":
        return <ApprovalCard item={item} actions={actions} />;

      case "notice":
        return (
          <div className={`bar bar-${noticeTone(item.level)}`} style={{ marginBottom: 12 }}>
            <Icon name={item.level === "ok" ? "check" : "alert"} />
            {item.text}
          </div>
        );
    }
  },
  // `item` 是可变对象，只比指纹；`actions` 引用恒定
  (a, b) => a.revision === b.revision && a.expanded === b.expanded && a.actions === b.actions,
);

function ToolCard({
  item,
  expanded,
  onToggle,
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
  expanded: boolean;
  onToggle: (id: string) => void;
}): React.ReactElement {
  const status = toolStatusMeta(item.status);
  const lines = item.output.split("\n");
  const shown = expanded ? item.output : lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n");

  return (
    <div className="row">
      <div className="avatar bot">
        <Icon name="sparkles" size={13} />
      </div>
      <div className="stack">
        <div className="card" style={{ width: "100%" }}>
          <div className="card-head">
            <span className="card-name">{item.name}</span>
            <span className={`pill pill-${status.tone}`}>
              {item.status === "running" ? <Dot /> : null}
              {status.label}
            </span>
            <span className="spacer" />
            <span style={{ fontSize: 11, color: "var(--Client-text-tertiary)" }}>
              {toolMetaLine(item.durationMs, item.status)}
            </span>
          </div>
          {describeArgs(item) ? (
            <div className="card-args" title={describeArgs(item)}>
              {describeArgs(item)}
            </div>
          ) : null}
          {item.output.length > 0 ? (
            <div className="card-out">
              <pre className={item.status === "failed" ? "err" : undefined}>{shown}</pre>
              {lines.length > OUTPUT_PREVIEW_LINES ? (
                <button className="card-more" onClick={() => onToggle(item.id)}>
                  {expanded ? "收起" : `展开全部（${lines.length} 行）`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ApprovalCard({
  item,
  actions,
}: {
  item: Extract<TimelineItem, { kind: "approval" }>;
  actions: Actions;
}): React.ReactElement {
  const request = item.request;
  const risk = riskMeta(request.risk.level);
  const high = request.risk.level === "high";
  const pending = item.state === "pending";

  return (
    <div className="row">
      <div className="avatar bot">
        <Icon name="sparkles" size={13} />
      </div>
      <div className="stack" style={{ maxWidth: "92%" }}>
        <div className={`approval${high ? " high" : ""}`} style={{ width: "100%" }}>
          <div className="approval-head">
            <Icon
              name={high ? "alert" : "shield"}
              color={high ? "var(--Client-danger-text)" : "var(--Client-warn-text)"}
            />
            <span className="card-name">{request.toolName}</span>
            <span className={`pill pill-${risk.tone}`}>{risk.label}</span>
            <span className="spacer" />
            <span style={{ fontSize: 11, color: "var(--Client-text-tertiary)" }}>
              {pending ? (
                <Waiting since={request.createdAt} />
              ) : (
                approvalStatusText(item.state)
              )}
            </span>
          </div>

          {request.identity && request.identity.depth > 0 ? (
            <div className="card-args">{`来自子 Agent（depth=${request.identity.depth}）`}</div>
          ) : null}

          {/* 高危：只列原因。降级理由叠上来会把最致命的那条淹掉 */}
          {high ? (
            <ul className="reasons" style={{ paddingLeft: 11 }}>
              {request.risk.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : (
            <>
              {request.summary.length > 0 ? (
                <ul>
                  {request.summary.map((line) => (
                    <li key={line}>
                      <code>{line}</code>
                    </li>
                  ))}
                </ul>
              ) : null}
              {request.risk.reasons.length > 0 ? (
                <ul className="reasons">
                  {request.risk.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
            </>
          )}

          {request.argsPreview ? <pre>{request.argsPreview}</pre> : null}

          <div className="approval-actions">
            <button
              className="btn btn-yes"
              disabled={!pending}
              onClick={() => actions.decide(request.id, "yes")}
            >
              仅本次允许
            </button>
            <button
              className="btn btn-always"
              disabled={!pending}
              onClick={() => actions.decide(request.id, "always")}
            >
              {`本会话内全部允许 ${request.toolName}`}
            </button>
            <button
              className="btn btn-no"
              disabled={!pending}
              onClick={() => actions.decide(request.id, "no")}
            >
              拒绝
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 挂起时长。
 *
 * 审批卡是 memo 的，父级不会因为"过了一秒"而重画；这里自带一个 1s 的
 * 本地定时器，只让这一行字走，不牵动整条时间线。
 * 设计稿第 9 条：等待要显式说出来，并实时显示等了多久。
 */
function Waiting({ since }: { since: number }): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <>{`已等待 ${formatDuration(now - since)}`}</>;
}
