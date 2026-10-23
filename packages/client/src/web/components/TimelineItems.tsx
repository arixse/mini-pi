/**
 * 时间线的条目。
 *
 * 版式来自视觉交接稿 §3 的「01 执行中」：转录列四块加一个新块，
 * 顺序即时间顺序——指令 → 工具调用 → 模型正文 → 审批 → 已入队：
 * - 指令块：用户头像 + accent-soft 实心气泡，右对齐；已入队的那条换
 *   **空心描边气泡**，附元信息行与「撤回」；
 * - 工具调用：**单行**，生命周期标记 ● 运行中 / ✓ 完成 / ✖ 错误，
 *   不套三层盒子；参数必须渲染（设计稿第 7 条），结果超 6 行或超长
 *   才给「查看完整输出 / 复制」；
 * - 审批块：warn-soft 底，动作行四个（允许一次 / 本会话全部允许 /
 *   拒绝 / 看变更）；高危单独换 danger-soft，不叠加降级理由（第 10 条）；
 * - 模型正文：助手气泡，流式期间按纯文本渲染（半截 ``` 会让代码块
 *   在眼前反复跳），复制按钮 hover 出现。
 *
 * 每条都按 `revision` 指纹做 memo：条目对象是就地修改的，按引用比较的 memo
 * 会永远认为没变，于是整条时间线每次 delta 都要重画。
 */

import { memo, useEffect, useState } from "react";
import type { Actions } from "../actions";
import type { TimelineItem, ToolStatus } from "../state";
import { approvalStatusText, describeArgs, noticeTone } from "../items";
import { formatClock, formatDuration, riskMeta, toolMetaLine } from "../format";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

/** 工具结果在卡片里最多显示几行，超出给"展开全部" */
const OUTPUT_PREVIEW_LINES = 6;
/** 单行超长也算"超长"：一行 4KB 的 JSON 摊开会把整列顶翻 */
const OUTPUT_PREVIEW_CHARS = 2000;

/** 生命周期标记：配色 + 字形双重编码，色弱用户与截图场景都读得出 */
const TOOL_MARK: Record<ToolStatus, string> = {
  running: "●",
  done: "✓",
  failed: "✖",
};

export type ItemProps = {
  item: TimelineItem;
  /** `revisionOf(item)`：指纹不变就不重画这一条 */
  revision: string;
  expanded: boolean;
  onToggle: (id: string) => void;
  actions: Actions;
};

export const TimelineItemRow = memo(
  function TimelineItemRow({
    item,
    expanded,
    onToggle,
    actions,
  }: ItemProps): React.ReactElement {
    switch (item.kind) {
      case "user":
        return <UserBlock item={item} actions={actions} />;

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
                      onClick={() =>
                        void navigator.clipboard?.writeText(item.text)
                      }
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
          <div
            className={`bar bar-${noticeTone(item.level)}`}
            style={{ marginBottom: 12 }}
          >
            <Icon name={item.level === "ok" ? "check" : "alert"} />
            {item.text}
          </div>
        );
    }
  },
  // `item` 是可变对象，只比指纹；`actions` 引用恒定
  (a, b) =>
    a.revision === b.revision &&
    a.expanded === b.expanded &&
    a.actions === b.actions,
);

/**
 * 指令块。
 *
 * 已入队的那条是**空心描边气泡**（区别于已执行的实心），元信息行说明
 * "当前回合结束后执行"，并给「撤回」——内核对排队中的 Run 直接出队，
 * 前端只负责把这个出口接到 UI 上（handoff §5 缺口 3）。
 *
 * 气泡内左下角带发出时刻（`14:02`）：同一段会话里连发几条时，"哪条是
 * 刚说的"靠它对。入队中的那条不画——它的时刻还没有意义（执行顺序由
 * 队列定，不由说出时刻定），元信息行已经把该说的说了。
 */
function UserBlock({
  item,
  actions,
}: {
  item: Extract<TimelineItem, { kind: "user" }>;
  actions: Actions;
}): React.ReactElement {
  const clock = item.queued ? "" : formatClock(item.at);
  return (
    <div className="row right">
      <div className="avatar user">我</div>
      <div className="stack">
        <div className={`bubble-user${item.queued ? " queued" : ""}`}>
          {item.text}
          {clock ? <span className="bubble-time">{clock}</span> : null}
          {item.queued ? (
            <span className="queued-meta">
              已入队 · 当前回合结束后执行
              <button
                className="recall"
                title="撤回这条消息：排队中的任务会直接取消"
                onClick={() => actions.recall(item.id)}
              >
                <Icon name="undo" size={11} />
                撤回
              </button>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 工具调用：单行。
 *
 * 不套三层盒子——旧稿一张 grep 结果套了三层边框、两层背景，信息权重
 * 与视觉权重倒挂。整行是一个按钮：点它展开/收起输出；参数行内联展示，
 * 只写"跑了 grep"等于让用户信任一句没有证据的话（设计稿第 7 条）。
 */
function ToolCard({
  item,
  expanded,
  onToggle,
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
  expanded: boolean;
  onToggle: (id: string) => void;
}): React.ReactElement {
  const args = describeArgs(item);
  const lines = item.output.split("\n");
  const long =
    lines.length > OUTPUT_PREVIEW_LINES ||
    item.output.length > OUTPUT_PREVIEW_CHARS;
  const shown =
    expanded || !long
      ? item.output
      : lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n");
  const hasOutput = item.output.length > 0;

  return (
    <div className="row">
      <div className="stack">
        <button
          className={`tool-line${hasOutput ? " take-me" : ""}`}
          title={hasOutput ? (expanded ? "收起输出" : "展开输出") : item.name}
          onClick={() => (hasOutput ? onToggle(item.id) : undefined)}
        >
          <span className={`tool-mark is-${item.status}`}>
            {TOOL_MARK[item.status]}
          </span>
          <span className="tool-name">{item.name}</span>
          {args ? <span className="tool-args">{args}</span> : null}
          <span className="tool-meta">
            {toolMetaLine(item.durationMs, item.status)}
          </span>
        </button>
        {hasOutput ? (
          <>
            <pre
              className={`tool-out${item.status === "failed" ? " err" : ""}`}
            >
              {shown}
            </pre>
            {/* 输出被裁过才给这两个链接：看全的入口与复制。短输出本来就
                全在眼前，再摆一排链接只是噪音（设计稿第 2 页同此） */}
            {long ? (
              <div className="tool-links">
                <button className="tool-more" onClick={() => onToggle(item.id)}>
                  {expanded ? "收起" : "查看完整输出"}
                </button>
                <button
                  className="tool-more"
                  title="复制这段输出"
                  onClick={() =>
                    void navigator.clipboard?.writeText(item.output)
                  }
                >
                  复制
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 审批卡。
 *
 * 风险等级与命中原因由内核算好（`core/risk.ts`），前端只负责配色与
 * 按钮——同一条 `rm -rf` 在终端与网页上必须是同一个等级。高危单独
 * 成块（danger-soft），不叠加降级理由：一次列五条"删除文件/网络请求"
 * 会把最致命的那条淹掉（设计稿第 10 条）。
 *
 * 这里**不放「看变更」**：审批挂起时 Run 仍是 blocked，服务端按契约
 * 拒绝读 diff（`git add -N` 不能和正在执行的目录抢索引）。变更入口放在
 * 主列的隔离改动条上，任务结束后才可点。
 */
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
      <div className="stack" style={{ maxWidth: "92%" }}>
        <div
          className={`approval${high ? " high" : ""}`}
          style={{ width: "100%" }}
        >
          <div className="approval-head">
            <Icon name={high ? "alert" : "shield"} size={14} />
            <span className="card-name">
              {high ? `高危：${request.toolName}` : request.toolName}
            </span>
            <span className={`pill pill-${risk.tone}`}>{risk.label}</span>
            <span className="spacer" />
            <span
              style={{ fontSize: 11, color: "var(--Client-text-tertiary)" }}
            >
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

          {/* 高危：只列原因 + 完整命令 + 不可撤销提示。降级理由叠上来会把最致命的那条淹掉 */}
          {high ? (
            <>
              {request.risk.reasons.length > 0 ? (
                <ul className="reasons" style={{ paddingLeft: 11 }}>
                  {request.risk.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
              <div className="approval-pre">
                {request.argsPreview || "（没有参数预览）"}
              </div>
              <div className="approval-warn-line">此操作不可撤销</div>
            </>
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
              {request.argsPreview ? <pre>{request.argsPreview}</pre> : null}
            </>
          )}

          <div className="approval-actions">
            <button
              className="btn btn-yes"
              disabled={!pending}
              onClick={() => actions.decide(request.id, "yes")}
            >
              允许一次
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
