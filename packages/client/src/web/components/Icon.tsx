/**
 * 图标与状态点。
 *
 * 图标是 `index.html` 里内联的那套 `<symbol>`，名字来自固定枚举而不是
 * 用户输入——这是全站唯一一处"按名字拼引用"，换成 `<img>` 或 iconfont
 * 都会丢掉 `currentColor` 与随字号缩放。
 */

import type { CSSProperties } from "react";
import type { RunPhase } from "../../shared/types";

export function Icon({
  name,
  size,
  color,
}: {
  name: string;
  size?: number;
  color?: string;
}): React.ReactElement {
  const style: CSSProperties = {};
  if (size !== undefined) {
    style.fontSize = `${size}px`;
  }
  if (color !== undefined) {
    style.color = color;
  }
  return (
    <svg className="ic" style={size === undefined && color === undefined ? undefined : style}>
      <use href={`#i-${name}`} />
    </svg>
  );
}

/** 呼吸感的小圆点：只给"运行中"这类需要提示在动的徽标用 */
export function Dot(): React.ReactElement {
  return <i className="dot" />;
}

/**
 * 状态环（视觉交接稿 §4）：
 * - **空闲不画点**——没有信息的状态不该占一个像素；
 * - 进行中是转圈，待裁决是暂停形，排队是空心圈，终态是实心点；
 * - 优先级 待交互 > 运行中 > 完成 > 空闲，由调用方按这个次序选 phase。
 *
 * 形状而不是颜色：色弱用户与截图场景都读得出"在转"和"停下等你"的差别。
 */
export function StatusRing({
  phase,
  size = 10,
}: {
  phase: RunPhase | "idle";
  size?: number;
}): React.ReactElement | null {
  if (phase === "idle") {
    return null;
  }
  const tone =
    phase === "running"
      ? "running"
      : phase === "queued"
        ? "queued"
        : phase === "blocked"
          ? "blocked"
          : phase === "done"
            ? "done"
            : phase === "failed"
              ? "failed"
              : "cancelled";
  return (
    <span
      className={`ring ring-${tone}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
