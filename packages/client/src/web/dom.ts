/**
 * DOM 构造的小工具。
 *
 * 只用 `createElement` 与 `textContent`，**不用 innerHTML**：模型输出的正文、
 * 工具结果、文件内容全都是不可信文本，拼 HTML 就等于把 XSS 开在界面上。
 * 唯一的例外是图标（名字来自固定枚举，不是用户输入）。
 */

export type Child = Node | string | null | undefined | false;

type Props = {
  class?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  id?: string;
  hidden?: boolean;
  inputmode?: string;
  onclick?: (event: MouseEvent) => void;
  oninput?: (event: Event) => void;
  onkeydown?: (event: KeyboardEvent) => void;
  onchange?: (event: Event) => void;
  href?: string;
  "aria-label"?: string;
  "aria-selected"?: string;
  "aria-pressed"?: string;
  style?: string;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyProps(node, props);
  append(node, children);
  return node;
}

function applyProps(node: HTMLElement, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === "text") {
      node.textContent = String(value);
    } else if (key.startsWith("on") && typeof value === "function") {
      const type = key.slice(2);
      node.addEventListener(type, value as EventListener);
    } else if (key === "disabled") {
      (node as HTMLButtonElement).disabled = Boolean(value);
    } else if (key === "value") {
      (node as HTMLInputElement).value = String(value);
    } else if (key === "hidden") {
      node.hidden = Boolean(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

export function append(node: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** 图标：`index.html` 里内联的那套 symbol，名字是固定枚举 */
export function icon(name: string, options: { size?: number; color?: string } = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "ic");
  if (options.size) {
    svg.setAttribute("style", `font-size:${options.size}px`);
  }
  if (options.color) {
    svg.setAttribute("style", `${svg.getAttribute("style") ?? ""};color:${options.color}`);
  }
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

/** 状态点（`.dot`）：只在"运行中"这类需要呼吸感的徽标里用 */
export function dot(): HTMLElement {
  return el("i", { class: "dot" });
}
