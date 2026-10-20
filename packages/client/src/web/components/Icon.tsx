/**
 * 图标与状态点。
 *
 * 图标是 `index.html` 里内联的那套 `<symbol>`，名字来自固定枚举而不是
 * 用户输入——这是全站唯一一处"按名字拼引用"，换成 `<img>` 或 iconfont
 * 都会丢掉 `currentColor` 与随字号缩放。
 */

import type { CSSProperties } from "react";

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
