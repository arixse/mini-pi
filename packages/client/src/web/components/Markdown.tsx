/**
 * Markdown 的渲染端：react-markdown + remark-gfm。
 *
 * 三条立场，一条都不比手写解析器松：
 *
 * 1. **不产出 HTML**。react-markdown 默认就把 markdown 里的裸 HTML
 *    （`<img onerror=…>` 之类）降级成**文本节点**，由 React 转义后显示；
 *    我们不加 `rehype-raw`、不开 `skipHtml`，也不碰
 *    `dangerouslySetInnerHTML`。模型正文是不可信文本，这条由
 *    `markdown.test.ts` 拿真实输出钉住。
 * 2. **外链新开标签**。从这个界面点走等于把正在跑的任务连根拔掉，
 *    所以 `a` 一律 `target="_blank" rel="noopener noreferrer"`。
 * 3. **GFM**：表格、删除线、自动链接走 `remark-gfm`——模型经常产出表格，
 *    而手写解析器那一版刻意不支持（`git log` 里有当时"保持两端一致"的
 *    理由），现在按用户要求换成成熟实现。
 *
 * 流式期间不走这里：`TimelineItems` 在 `streaming` 时按纯文本渲染，
 * 每个 delta 跑一遍完整解析纯属浪费，半截的 ``` 还会让代码块反复跳。
 */

import type { AnchorHTMLAttributes } from "react";
// 注意：`Markdown` 在这个包里只有**默认导出**（根 index.js 把命名导出
// 收敛成了 default），写 `import { Markdown }` 类型过得去但运行期炸
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type AnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown };

/** 外链新开标签；`node` 是 react-markdown 的内部参数，不能往 DOM 上摊 */
function Anchor({ node: _node, ...rest }: AnchorProps): React.ReactElement {
  return <a {...rest} target="_blank" rel="noopener noreferrer" />;
}

const components: Components = { a: Anchor };

export function Markdown({ text }: { text: string }): React.ReactElement {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>;
}
