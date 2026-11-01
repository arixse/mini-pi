/**
 * 会话标题的宽度口径。
 *
 * 侧栏一行里能放标题的地方是固定的（264~320 的侧栏减去缩进、条数、行菜单），
 * 而标题来源是用户原话——一段可以很长的话。以前按"40 个字符"截断，可是
 * 40 个汉字在侧栏里要占三行的宽度，于是侧栏只能靠 CSS 硬切；
 * 现在统一按**显示宽度**算：全角算 2，半角算 1，长度就有意义了。
 *
 * 模型生成的标题也走同一个 `clipTitle`：提示词里那句"不超过 N 个字"是
 * 请求，不是保证，落库前必须再按宽度兜一次——否则一次不听话的输出就能
 * 把侧栏排版顶回原样。
 */

/**
 * 标题的显示宽度上限。
 *
 * 32 ≈ 16 个汉字。侧栏一行里标题的可用宽度只有 120px 左右（1366 视口、
 * 侧栏 264、12.5px 字号），10 个汉字就到头——也就是说**标题几乎总会被 CSS
 * 再切一刀**，切在哪一格由它按真实像素算，比这里估算得准。
 *
 * 既然靠 CSS 收尾、侧栏又给了 hover 看全文（`SessionSummary.excerpt`），
 * 这里就没必要压到"刚好塞得下"：模型多几个字才说得清"要做什么"。
 * 早先取 24（12 汉字）时，标题经常被切成一个读不出主语的名词短语。
 */
export const TITLE_MAX_WIDTH = 32;

/** 模型提示词里承诺的字数，与 {@link TITLE_MAX_WIDTH} 同一个口径（汉字数） */
export const TITLE_MAX_HANZI = TITLE_MAX_WIDTH / 2;

/**
 * hover 提示里"原话"的宽度上限：240 格 ≈ 120 个汉字。
 *
 * 再长就不再是提示而是重读一遍正文了；一段真正的长需求（贴了整份报错）
 * 本来也不该指望 tooltip——那一整段在时间线里就能看。
 */
export const EXCERPT_MAX_WIDTH = 240;

/** 宽字符（CJK、全角标点、emoji）在等宽度量里按两格算 */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}]|[\u{1F900}-\u{1F9FF}]/u;

export function titleWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += WIDE.test(char) ? 2 : 1;
  }
  return width;
}

/**
 * 去掉包裹整体的那层引号。
 *
 * 模型很爱输出「客户端颜色令牌收敛」或 “…” 这样的整句包裹；侧栏已经用
 * 位置和样式表明"这是标题"，再套一层引号只是白占两格宽度。
 *
 * 只剥**成对且包住整串**的那一层：`「A」和「B」` 首尾虽然也是「」，但中间
 * 还有引号，剥掉会得到 `A」和「B` —— 所以先检查内部是否还有同类引号。
 */
function unwrap(text: string): string {
  const pairs: Array<[string, string]> = [
    ["「", "」"],
    ["『", "』"],
    ["“", "”"],
    ["‘", "’"],
    ['"', '"'],
    ["'", "'"],
  ];
  for (const [open, close] of pairs) {
    if (text.length <= open.length + close.length) {
      continue;
    }
    if (!text.startsWith(open) || !text.endsWith(close)) {
      continue;
    }
    const inner = text.slice(open.length, text.length - close.length).trim();
    if (inner.length > 0 && !inner.includes(open) && !inner.includes(close)) {
      return inner;
    }
  }
  return text;
}

/** 标题不该以句读收尾：它是一行标签，不是一句话 */
const TRAILING = /[。．，、；：,.;:!！?？\s]+$/u;

/**
 * 按显示宽度截断，末尾补 `…`（省略号自己也占 1 格，算在总量里）。
 *
 * 从字符边界切，不会把一个全角字符劈成半格；截在空格前面时把尾巴的空格
 * 收掉再拼省略号，免得出现"…"前多一个空格。
 */
function cutToWidth(text: string, maxWidth: number): string {
  const budget = maxWidth - 1;
  let width = 0;
  let cut = "";
  for (const char of text) {
    const next = width + titleWidth(char);
    if (next > budget) {
      break;
    }
    width = next;
    cut += char;
  }
  return `${cut.replace(/\s+$/u, "")}…`;
}

/**
 * 把一段文本收成一行标题：折叠空白 → 剥引号 → 去句尾标点 → 按宽度截断。
 *
 * 已经放得下的标题原样返回，不改写——用户的原话有时候比总结更像标题。
 */
export function clipTitle(raw: string, maxWidth = TITLE_MAX_WIDTH): string {
  // 顺序有讲究：先去空白和句尾标点，再剥引号——`「标题」。` 只有先去掉
  // 那个句号，引号才成为整串的首尾；剥完引号里面还可能有标点，再收一次
  const flat = unwrap(raw.replace(/\s+/gu, " ").trim().replace(TRAILING, ""))
    .replace(TRAILING, "")
    .trim();
  if (flat.length === 0) {
    return "";
  }
  if (titleWidth(flat) <= maxWidth) {
    return flat;
  }
  return cutToWidth(flat, maxWidth);
}

/**
 * 收一段"原话"给 hover 查看用。
 *
 * 与 {@link clipTitle} 的差别是**它保留原文**：不剥包裹引号、不去句尾标点，
 * 那些都是"标题"该做的加工。这里只折叠空白——多行粘贴原样塞进 tooltip
 * 会变成一屏散行，长度也没法控——再按宽度截断。
 */
export function excerptOf(raw: string, maxWidth = EXCERPT_MAX_WIDTH): string {
  const flat = raw.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) {
    return "";
  }
  if (titleWidth(flat) <= maxWidth) {
    return flat;
  }
  return cutToWidth(flat, maxWidth);
}
