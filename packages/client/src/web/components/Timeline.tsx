/**
 * 时间线：一次执行的呈现，也是这个界面最主要的东西。
 *
 * 两条实现约束：
 * - **只在贴底时自动跟随**。用户往上翻历史时新内容把视野拽回底部，等于
 *   把正在读的东西抽走。
 * - **条目按指纹 memo**。流式输出每秒几十条事件，整棵树重画会丢滚动位置，
 *   也会把"展开全部"这类局部状态冲掉。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { pendingApprovals } from "../state";
import { revisionOf } from "../items";
import { useActions, useClient, useRevision } from "../store";
import { resolveHeights, virtualRange, type VirtualRange } from "../virtual";
import { Icon } from "./Icon";
import { RunHead } from "./RunHead";
import { TimelineItemRow } from "./TimelineItems";

/** 距底多少像素算"贴着底部看" */
const STICK_THRESHOLD_PX = 80;

export function Timeline(): React.ReactElement {
  const state = useClient();
  const actions = useActions();
  const revision = useRevision();
  const hostRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  /** 已经处理到哪个审批跳转 nonce：同一个请求只滚一次，重渲染不来回拽 */
  const handledApprovalJump = useRef(0);

  /**
   * 条目高度：按 id 记住测过的值。
   *
   * 不放进 state：它只在窗口计算时被读，改它只需触发一次重画；
   * 用 `measureTick` 当版本号，避免为每一条建一个 state。
   */
  const heights = useRef<Map<string, number>>(new Map());
  const [measureTick, setMeasureTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  /** 条目列表在滚动内容里的起点（运行头 / 提示条都在它上面） */
  const [listOffset, setListOffset] = useState(0);
  const offsetRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  /**
   * 审批跳转时临时全量渲染。
   *
   * 窗口化后那张审批卡可能正好在窗口外，`querySelector` 找不到它。
   * 这不是"渲染坏了"，所以先全量、滚到位，再收回窗口。
   */
  const [forceAll, setForceAll] = useState(false);

  const measure = useCallback((id: string, height: number): void => {
    if (!(height > 0)) {
      return;
    }
    const previous = heights.current.get(id);
    if (previous !== undefined && Math.abs(previous - height) < 0.5) {
      return;
    }
    heights.current.set(id, height);
    setMeasureTick((tick) => tick + 1);
  }, []);

  // 展开/收起是纯展示状态，不进 store：它不影响任何别处
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const onScroll = useCallback(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }
    const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottom.current = gap < STICK_THRESHOLD_PX;
    // 一帧只读一次滚动位置：滚动事件比帧密，直接 setState 会让整条
    // 时间线跟着每秒重画几十次（正是窗口化要消掉的那部分开销）
    if (rafRef.current !== null) {
      return;
    }
    const schedule =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback: FrameRequestCallback): number =>
            window.setTimeout(() => callback(0), 16);
    rafRef.current = schedule(() => {
      rafRef.current = null;
      const current = hostRef.current;
      if (current) {
        setScrollTop(current.scrollTop);
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = null;
    };
  }, []);

  // 换会话 = 换一条时间线：滚动位置不能沿用上一条的（否则窗口会从中间开始）
  useEffect(() => {
    stickToBottom.current = true;
    setScrollTop(0);
  }, [state.view.sessionId]);

  // 视口高度：窗口大小变化、侧栏开合都会改它
  useEffect(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }
    const sync = (): void => {
      setViewport(element.clientHeight);
      setScrollTop(element.scrollTop);
    };
    sync();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [state.workspace.root]);

  // 条目列表的起点：上方提示条增减会让它整体上下移。每帧一次布局读取，
  // 比"猜一个固定的高度"可靠（提示条数量随状态变）
  useEffect(() => {
    const element = hostRef.current;
    const list = listRef.current;
    const next =
      element && list
        ? list.getBoundingClientRect().top -
          element.getBoundingClientRect().top +
          element.scrollTop
        : 0;
    offsetRef.current = next;
    setListOffset((previous) => (Math.abs(previous - next) < 0.5 ? previous : next));
  });

  useEffect(() => {
    const element = hostRef.current;
    if (!element) {
      return;
    }
    // 审批跳转优先于"贴底跟随"：卡片可能还在事件流重放的路上，没找到时
    // 不标记已处理，下一次 revision 继续试。
    const jump = state.ui.approvalJump;
    if (
      jump &&
      jump.nonce !== handledApprovalJump.current &&
      state.view.activeRunId === jump.runId
    ) {
      const card = element.querySelector<HTMLElement>('[data-pending-approval="true"]');
      if (card) {
        card.scrollIntoView({ block: "center" });
        handledApprovalJump.current = jump.nonce;
        setForceAll(false);
        return;
      }
      // 窗口化时卡片可能在窗口外：先全量渲染一遍再找
      if (!forceAll) {
        setForceAll(true);
        return;
      }
    }
    if (stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
      setScrollTop(element.scrollTop);
    }
  }, [
    revision,
    measureTick,
    state.ui.approvalJump,
    state.view.activeRunId,
    forceAll,
    state.view.sessionId,
  ]);

  // 还没有工作区：主区只放品牌与一个动作（交接稿 §3「05 空态引导」）。
  // 放在所有 hook 之后——提前 return 会改变 hook 次序
  if (!state.workspace.root) {
    return (
      <main className="main" id="timeline">
        <div className="main-inner">
          <EmptyGuide />
        </div>
      </main>
    );
  }

  const items = state.view.items;
  const ids = items.map((item) => item.id);
  const range: VirtualRange = forceAll
    ? { virtual: false, start: 0, end: items.length, top: 0, bottom: 0, total: 0 }
    : virtualRange(
        resolveHeights(ids, heights.current),
        Math.max(0, scrollTop - listOffset),
        viewport,
      );
  const visible = items.slice(range.start, range.end);

  return (
    <main className="main" id="timeline" ref={hostRef} onScroll={onScroll}>
      <div className="main-inner">
        <RunHead />
        <Banners />
        {state.view.sessionId === null && items.length === 0 ? (
          <div className="empty-hint draft-hint">
            <Icon name="sparkles" size={14} />
            <span>
              新任务：直接在下面对话。这段会话还不在磁盘上——发出第一条消息时才创建
            </span>
          </div>
        ) : null}
        <div className="timeline-items" ref={listRef}>
          {range.top > 0 ? (
            // 占位块撑住"上面还有多少"：滚动条长度与位置都不变
            <div style={{ height: range.top }} aria-hidden="true" />
          ) : null}
          {visible.map((item) => (
            <MeasuredItem key={item.id} id={item.id} onMeasure={measure}>
              <TimelineItemRow
                item={item}
                revision={revisionOf(item)}
                expanded={expanded.has(item.id)}
                onToggle={toggle}
                actions={actions}
              />
            </MeasuredItem>
          ))}
          {range.bottom > 0 ? <div style={{ height: range.bottom }} aria-hidden="true" /> : null}
        </div>
      </div>
    </main>
  );
}

/**
 * 量一条的高度。
 *
 * 用 `flow-root` 容器把子元素的 margin 也算进高度：直接量 `.row` 会漏掉
 * `margin-bottom`，占位块与真实内容就会差出"每条 12px"，滚动条一路漂移。
 */
function MeasuredItem({
  id,
  onMeasure,
  children,
}: {
  id: string;
  onMeasure: (id: string, height: number) => void;
  children: React.ReactNode;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const report = (): void => onMeasure(id, element.offsetHeight);
    report();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    // 流式输出、展开工具输出都会让同一条变高：观察它而不是只量一次
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, onMeasure]);

  return (
    <div className="v-item" ref={ref} data-item-id={id}>
      {children}
    </div>
  );
}


/**
 * 空态引导：还没有工作区时，主区只放品牌与「选择目录」。
 *
 * 一句人话 + 一个动作，不摆功能清单——这一刻用户还没决定把项目放在哪，
 * 介绍什么都为时过早。选了目录，界面自己会长出内容来。
 */
function EmptyGuide(): React.ReactElement {
  const actions = useActions();
  return (
    <div className="empty-guide">
      <div className="eg-brand">
        <Icon name="logo" size={26} color="var(--Client-accent-text)" />
        mini-pi
      </div>
      <p className="eg-text">选择一个目录作为工作区：之后的任务、会话与改动，都发生在它里面。</p>
      <button className="btn btn-yes" onClick={() => actions.openPicker()}>
        <Icon name="folder" size={12} />
        选择目录…
      </button>
    </div>
  );
}

function Banners(): React.ReactElement {
  const state = useClient();
  const actions = useActions();
  const view = state.view;
  const pending = pendingApprovals(view);

  return (
    <div>
      {pending > 0 ? (
        // 挂起必须显式说出来：一个"什么都不动"的界面，
        // 用户分不清是卡住、断线，还是在等他
        <div className="bar bar-err">
          <Icon name="alert" />
          {`任务已挂起：有 ${pending} 次工具调用在等你裁决`}
        </div>
      ) : null}
      {view.status === "failed" && view.runError ? (
        // 状态徽标只说"失败"，原因必须单独说出来，否则用户只能去翻服务端日志
        <div className="bar bar-err">
          <Icon name="alert" />
          {`任务失败：${view.runError}`}
        </div>
      ) : null}
      {state.banner ? (
        <div className={`bar bar-${state.banner.level === "error" ? "err" : state.banner.level}`}>
          <Icon name="alert" />
          {state.banner.text}
        </div>
      ) : null}
      {view.streamNote ? (
        <div className="bar bar-warn">
          <Icon name="alert" />
          {view.streamNote}
          {view.streamLost ? (
            <button className="bar-action" onClick={() => actions.retryStreams()}>
              重试连接
            </button>
          ) : null}
        </div>
      ) : null}
      {state.globalNote ? (
        // 后台同步断了不影响当前这一轮，但"别的任务停在旧状态"必须说出来
        <div className="bar bar-warn">
          <Icon name="alert" />
          {state.globalNote}
          {state.globalLost ? (
            <button className="bar-action" onClick={() => actions.retryStreams()}>
              重试连接
            </button>
          ) : null}
        </div>
      ) : null}
      {view.gap ? (
        <div className="bar bar-warn">
          <Icon name="alert" />
          事件流有缺口：正在用会话历史自动补齐……
          <button className="bar-action" onClick={() => actions.retryStreams()}>
            重试连接
          </button>
        </div>
      ) : null}
      {view.status === "queued" ? (
        <div className="bar bar-warn">
          <Icon name="shield" />
          已入队：同一会话里前一个任务结束后自动开始
        </div>
      ) : null}
    </div>
  );
}
