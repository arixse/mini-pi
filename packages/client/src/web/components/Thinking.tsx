/**
 * 「思考中」指示：模型在跑、但还没吐出第一个 token 的那一段。
 *
 * 这段时间界面本来是完全静止的——用户发完消息盯着一动不动的转录列，
 * 分不清模型在思考、网络断了，还是任务已经卡死。终端里有一行
 * `⠋ 思考中… 1.4s` 回答的正是这个问题，网页这边之前没有对应物。
 *
 * 两个实现约束：
 * - 指示挂在时间线**末尾**（跟着内容走），而不是停在运行头里；
 * - 耗时自带 1s 定时器：时间线是虚拟化的，让父级每秒重画会牵动整棵树。
 */

import { useEffect, useState } from "react";
import { formatDuration } from "../format";
import { Icon } from "./Icon";

export function ThinkingRow({ since }: { since: number }): React.ReactElement {
  return (
    <div className="row">
      <div className="avatar bot">
        <Icon name="sparkles" size={13} />
      </div>
      <div className="stack">
        {/* role=status + aria-live：读屏用户同样需要知道"它在想" */}
        <div className="thinking-line" role="status" aria-live="polite">
          <span className="thinking-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="thinking-label">Thinking</span>
          <Elapsed since={since} />
        </div>
      </div>
    </div>
  );
}

/**
 * 已经想了多久。
 *
 * `since` 变化就重起定时器：同一轮里 `turn_start` 与 `message_start`
 * 会先后点亮它，计数要从最新那一刻算，不能把上一次的秒数带过来。
 */
function Elapsed({ since }: { since: number }): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);

  return <span className="thinking-elapsed">{formatDuration(now - since)}</span>;
}
