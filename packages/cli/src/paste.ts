/**
 * 大段粘贴的入口缓冲。
 *
 * 直接把终端里的粘贴内容交给 readline 有两个后果：
 *
 * 1. **卡死**：readline 每收到一个字符就重画整行，10 万字单行粘贴是 O(n²)，
 *    实测 120s 都画不完；
 * 2. **一条内容变成一百个回合**：多行粘贴里的每个换行都会触发一次 `line`，
 *    于是每行都被排进输入队列，模型看到的是 100 条互不相干的消息。
 *
 * 这里在 stdin 与 readline 之间垫一层 `PassThrough`：打开终端的 bracketed
 * paste 模式（`ESC[?2004h`），把 `ESC[200~ ... ESC[201~` 之间的内容整段收下，
 * 大段/多行内容折叠成一个占位符（`[粘贴内容 #1 · 240 行 · 12.4 KB]`），
 * 提交时再由 `expand()` 换回原文。占位符只占几十列，readline 的重画成本与
 * 一条普通输入相同。
 *
 * 没有 bracketed paste 的终端（或管道）走兜底启发式：把连续到达的
 * "像粘贴"的数据先攒 `batchMs` 毫秒，再按同一套规则折叠。普通按键仍然
 * 立即转发，输入延迟不受影响。
 *
 * 选择器与隐藏输入（`/model` 筛选、`/login` 的 API Key）需要原始字符，
 * 由它们调用 `suspendPasteCollapse()` 临时关掉折叠；此时只剥掉 bracketed
 * paste 的标记，内容原样转发。
 */

import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** 终端进入 bracketed paste 模式的 CSI 序列（写到 stdout） */
export const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
/** 退出 bracketed paste 模式的 CSI 序列 */
export const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";
/** 终端包在粘贴内容前后的标记 */
export const BRACKETED_PASTE_START = "\u001b[200~";
export const BRACKETED_PASTE_END = "\u001b[201~";

/** 单行超过这么多字符就折叠（再长就会明显拖慢 readline 重画） */
export const DEFAULT_MAX_INLINE_CHARS = 200;
/** 非 bracketed 粘贴的嗅探阈值：一段数据达到这么多字符才当成粘贴 */
export const DEFAULT_SNIFF_CHARS = 24;
/** 非 bracketed 粘贴的静默窗口：连续数据停止这么久才认为粘贴结束 */
export const DEFAULT_BATCH_MS = 25;
/** 疑似 bracketed paste 标记被截断时，最多等这么久再按普通按键转发 */
export const DEFAULT_PARTIAL_MS = 15;
/** 最多保留多少个可展开的占位符（防止超长会话无限占内存） */
export const MAX_PASTE_TOKENS = 64;

/** 一段粘贴内容的体量，用于生成占位符摘要 */
export interface PasteMetrics {
  /** 行数（没有换行时为 1） */
  lines: number;
  /** 码点数量（emoji 不会被算成两个） */
  chars: number;
  /** UTF-8 字节数 */
  bytes: number;
}

/** 去掉粘贴内容末尾的一个换行：粘贴不该顺带替用户按下回车 */
export function stripTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) {
    return text.slice(0, -2);
  }
  if (text.endsWith("\n") || text.endsWith("\r")) {
    return text.slice(0, -1);
  }
  return text;
}

export function measurePaste(text: string): PasteMetrics {
  return {
    lines: text.split(/\r\n|\r|\n/).length,
    chars: Array.from(text).length,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

/** 人类可读的体积；粘贴摘要里不展示小数过多的精度 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 生成可回查的占位符。
 *
 * 编号让同一条输入里的多次粘贴互不混淆；行数与体积就是用户判断
 * "粘对了没有"的最小信息，不把正文回显到终端。
 */
export function formatPastePlaceholder(id: number, text: string): string {
  const { lines, bytes } = measurePaste(text);
  const shape = lines > 1 ? `${lines} 行 · ${formatByteSize(bytes)}` : formatByteSize(bytes);
  return `[粘贴内容 #${id} · ${shape}]`;
}

/**
 * 是否值得折叠。
 *
 * 多行必折：否则每个换行都会变成一次独立提交。单行只在超过阈值时折叠，
 * 一句正常长度的粘贴仍然原样显示，用户能看见自己粘了什么。
 */
export function shouldCollapsePaste(
  text: string,
  maxInlineChars: number = DEFAULT_MAX_INLINE_CHARS,
): boolean {
  if (text === "") {
    return false;
  }
  if (text.split(/\r\n|\r|\n/).length > 1) {
    return true;
  }
  return Array.from(text).length > maxInlineChars;
}

/**
 * `text` 末尾有多长的后缀是 `marker` 的前缀。
 *
 * 数据块可能在 `ESC[200~` / `ESC[201~` 中间断开，必须把这段尾巴留在
 * 缓冲区里等下一块，而不是急着当普通按键送进 readline。
 */
export function longestPrefixSuffix(text: string, marker: string): number {
  const max = Math.min(marker.length - 1, text.length);
  for (let length = max; length > 0; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

export interface PasteInputOptions {
  maxInlineChars?: number;
  sniffChars?: number;
  batchMs?: number;
  partialMs?: number;
  /** 折叠发生时的回调（测试与遥测用） */
  onCollapse?: (token: string, text: string) => void;
}

/**
 * 垫在 stdin 与 readline 之间的输入流。
 *
 * 它只做三件事：识别 bracketed paste、把大段内容换成占位符、把占位符
 * 换回原文。终端 raw mode 仍然代理给真正的 stdin——readline 与选择器
 * 原有的暂停/恢复逻辑一行都不用改。
 */
export class PasteInput extends PassThrough {
  public readonly isTTY: boolean;

  private readonly source: NodeJS.ReadStream;
  private readonly maxInlineChars: number;
  private readonly sniffChars: number;
  private readonly batchMs: number;
  private readonly partialMs: number;
  private readonly onCollapse?: (token: string, text: string) => void;
  private readonly decoder = new StringDecoder("utf8");

  /** 尚未判定的普通数据（可能是 bracketed paste 标记的前半截） */
  private normalBuffer = "";
  private inPaste = false;
  private pasteParts: string[] = [];
  private pasteTail = "";

  /** 非 bracketed 粘贴的攒批 */
  private batchParts: string[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private partialTimer: ReturnType<typeof setTimeout> | null = null;

  /** 选择器 / 隐藏输入临时关掉折叠的嵌套计数 */
  private collapseDepth = 0;

  private nextTokenId = 1;
  private readonly tokens = new Map<string, string>();
  private readonly tokenOrder: string[] = [];
  private disposed = false;

  constructor(source: NodeJS.ReadStream, options: PasteInputOptions = {}) {
    super();
    this.source = source;
    this.isTTY = Boolean(source.isTTY);
    this.maxInlineChars = options.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS;
    this.sniffChars = options.sniffChars ?? DEFAULT_SNIFF_CHARS;
    this.batchMs = options.batchMs ?? DEFAULT_BATCH_MS;
    this.partialMs = options.partialMs ?? DEFAULT_PARTIAL_MS;
    this.onCollapse = options.onCollapse;

    source.on("data", this.handleSourceData);
    source.on("end", this.handleEnd);
    source.on("error", this.handleError);
    source.resume?.();
  }

  /** readline 会读它判断当前是否 raw mode */
  get isRaw(): boolean {
    return Boolean((this.source as NodeJS.ReadStream & { isRaw?: boolean }).isRaw);
  }

  /** readline / 选择器切换 raw mode 时，最终要落到真 stdin 上 */
  setRawMode(mode: boolean): this {
    (this.source as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }).setRawMode?.(
      mode,
    );
    return this;
  }

  /** 把一行里的占位符换回完整粘贴内容；不认识的占位符保持原样 */
  expand(line: string): string {
    if (this.tokens.size === 0 || !line.includes("[")) {
      return line;
    }
    let result = line;
    for (const [token, content] of this.tokens) {
      if (result.includes(token)) {
        result = result.split(token).join(content);
      }
    }
    return result;
  }

  /**
   * 临时关闭折叠（选择器筛选、隐藏输入）。
   *
   * 返回恢复函数；重复调用是安全的，用嵌套计数支持"选择器里再开一个提示"。
   */
  suspendCollapse(): () => void {
    this.collapseDepth += 1;
    let restored = false;
    return () => {
      if (restored) {
        return;
      }
      restored = true;
      this.collapseDepth = Math.max(0, this.collapseDepth - 1);
    };
  }

  /**
   * 立即处理所有攒批的数据（含被截断的标记前缀）。
   *
   * 生产路径由定时器驱动；测试与"stdin 马上要关闭"时可以直接调用。
   */
  flushPending(): void {
    if (this.partialTimer) {
      clearTimeout(this.partialTimer);
      this.partialTimer = null;
    }
    if (this.normalBuffer) {
      const pending = this.normalBuffer;
      this.normalBuffer = "";
      this.emitNormal(pending);
    }
    this.flushBatch();
  }

  /** 摘掉 stdin 监听并清空缓冲区；`startRepl` 退出时调用 */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    if (this.partialTimer) {
      clearTimeout(this.partialTimer);
    }
    this.batchTimer = null;
    this.partialTimer = null;
    this.normalBuffer = "";
    this.batchParts = [];
    this.pasteParts = [];
    this.pasteTail = "";
    this.inPaste = false;
    this.tokens.clear();
    this.tokenOrder.length = 0;
    this.source.removeListener("data", this.handleSourceData);
    this.source.removeListener("end", this.handleEnd);
    this.source.removeListener("error", this.handleError);
  }

  private handleSourceData = (data: string | Buffer): void => {
    if (this.disposed) {
      return;
    }
    const text = typeof data === "string" ? data : this.decoder.write(data);
    if (text) {
      this.consume(text);
    }
  };

  private handleEnd = (): void => {
    if (this.disposed) {
      return;
    }
    const tail = this.decoder.end();
    if (tail) {
      this.consume(tail);
    }
    this.flushPending();
    if (this.inPaste) {
      // 标记没等到结尾（终端被关掉等）：已收到的内容仍按一次粘贴处理
      const content = this.pasteParts.join("") + this.pasteTail;
      this.pasteParts = [];
      this.pasteTail = "";
      this.inPaste = false;
      this.handlePastedText(content);
    }
    if (!this.destroyed) {
      this.push(null);
    }
  };

  private handleError = (error: Error): void => {
    if (this.disposed) {
      return;
    }
    // 有消费者就按流的方式报错；没有的话安静收尾，避免把 stdin 的
    // 偶发错误升级成未捕获异常（readline 关闭时不会再挂 error 监听）
    if (this.listenerCount("error") > 0) {
      this.destroy(error);
    } else {
      this.push(null);
    }
  };

  private consume(text: string): void {
    let rest = text;
    while (rest !== "" && !this.disposed) {
      rest = this.inPaste ? this.consumePaste(rest) : this.consumeNormal(rest);
    }
  }

  /** 普通状态：找 bracketed paste 开头，其余数据按粘贴启发式转发 */
  private consumeNormal(data: string): string {
    const combined = this.normalBuffer + data;
    this.normalBuffer = "";

    const start = combined.indexOf(BRACKETED_PASTE_START);
    if (start === -1) {
      const hold = longestPrefixSuffix(combined, BRACKETED_PASTE_START);
      const emit = hold === 0 ? combined : combined.slice(0, combined.length - hold);
      this.emitNormal(emit);
      if (hold > 0) {
        this.normalBuffer = combined.slice(combined.length - hold);
        this.schedulePartial();
      } else {
        this.clearPartial();
      }
      return "";
    }

    this.emitNormal(combined.slice(0, start));
    this.clearPartial();
    // 先落定这批普通数据，再进入粘贴：否则占位符会跑到它前面
    this.flushBatch();
    this.inPaste = true;
    this.pasteParts = [];
    this.pasteTail = "";
    return combined.slice(start + BRACKETED_PASTE_START.length);
  }

  /** 粘贴状态：收集到 `ESC[201~` 为止；标记可能跨数据块 */
  private consumePaste(data: string): string {
    const combined = this.pasteTail + data;
    const end = combined.indexOf(BRACKETED_PASTE_END);

    if (end === -1) {
      const keep = Math.min(BRACKETED_PASTE_END.length - 1, combined.length);
      const commit = combined.slice(0, combined.length - keep);
      if (commit) {
        this.pasteParts.push(commit);
      }
      this.pasteTail = combined.slice(combined.length - keep);
      return "";
    }

    const content = this.pasteParts.join("") + combined.slice(0, end);
    this.pasteParts = [];
    this.pasteTail = "";
    this.inPaste = false;
    this.handlePastedText(content);
    return combined.slice(end + BRACKETED_PASTE_END.length);
  }

  /** 普通数据：短按键立即转发，像粘贴的先进攒批窗口 */
  private emitNormal(text: string): void {
    if (!text || this.disposed) {
      return;
    }
    if (!this.isCollapseEnabled()) {
      this.pushText(text);
      return;
    }
    // 方向键 / 鼠标等控制序列：即使长一点也立即转发，避免操作发涩
    if (text.startsWith("\u001b") && text.length < this.sniffChars) {
      this.pushText(text);
      return;
    }
    if (!this.looksLikePaste(text)) {
      this.pushText(text);
      return;
    }
    this.batchParts.push(text);
    this.scheduleBatch();
  }

  /** 没有 bracketed paste 时，凭"一次到达的字符数 / 是否含内部换行"判断 */
  private looksLikePaste(text: string): boolean {
    if (text.length >= this.sniffChars) {
      return true;
    }
    if (text === "\r" || text === "\n" || text === "\r\n") {
      return false;
    }
    // 末尾只有一个换行仍可能是"打字后回车"，不该折叠掉这次提交
    const body = text.replace(/[\r\n]+$/, "");
    return /[\r\n]/.test(body);
  }

  private scheduleBatch(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushBatch();
    }, this.batchMs);
    this.batchTimer.unref?.();
  }

  private flushBatch(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.batchParts.length === 0) {
      return;
    }
    const text = this.batchParts.join("");
    this.batchParts = [];
    this.handlePastedText(text);
  }

  private handlePastedText(text: string): void {
    if (!text) {
      return;
    }
    if (!this.isCollapseEnabled()) {
      // 选择器 / 隐藏输入：保留原始换行，行为和普通终端粘贴一致
      this.pushText(text);
      return;
    }
    const cleaned = stripTrailingNewline(text);
    if (!cleaned) {
      return;
    }
    if (shouldCollapsePaste(cleaned, this.maxInlineChars)) {
      this.emitToken(cleaned);
      return;
    }
    this.pushText(cleaned);
  }

  private emitToken(content: string): void {
    const id = this.nextTokenId;
    this.nextTokenId += 1;
    const token = formatPastePlaceholder(id, content);
    this.tokens.set(token, content);
    this.tokenOrder.push(token);
    while (this.tokenOrder.length > MAX_PASTE_TOKENS) {
      const oldest = this.tokenOrder.shift();
      if (oldest !== undefined) {
        this.tokens.delete(oldest);
      }
    }
    this.onCollapse?.(token, content);
    this.pushText(token);
  }

  private schedulePartial(): void {
    if (this.partialTimer) {
      clearTimeout(this.partialTimer);
    }
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null;
      const pending = this.normalBuffer;
      this.normalBuffer = "";
      this.emitNormal(pending);
    }, this.partialMs);
    this.partialTimer.unref?.();
  }

  private clearPartial(): void {
    if (this.partialTimer) {
      clearTimeout(this.partialTimer);
      this.partialTimer = null;
    }
  }

  private pushText(text: string): void {
    if (text && !this.disposed && !this.destroyed) {
      this.push(text);
    }
  }

  private isCollapseEnabled(): boolean {
    return this.collapseDepth === 0;
  }
}

/** 交给 REPL 的一小组接口；非交互式输入时是恒等实现 */
export interface PasteBridge {
  /** 交给 `createInterface` 的输入流 */
  input: NodeJS.ReadStream;
  /** 是否真的接管了 stdin */
  interactive: boolean;
  /** 把一行里的占位符换回原文 */
  expand: (line: string) => string;
  /** 退出时摘掉监听 */
  dispose: () => void;
}

/**
 * 创建 REPL 用的粘贴桥。
 *
 * 只有交互式终端才接管：管道输入（`echo ... | mini-pi`）的每一行本来
 * 就是一次有意义的提交，折叠成占位符反而会改变语义。
 */
export function createPasteBridge(
  stdin: unknown,
  options: PasteInputOptions = {},
): PasteBridge {
  const source = stdin as Partial<NodeJS.ReadStream> & { isTTY?: boolean };
  const canWrap =
    Boolean(source?.isTTY) &&
    typeof (source as { on?: unknown }).on === "function" &&
    typeof (source as { removeListener?: unknown }).removeListener === "function";

  if (!canWrap) {
    return {
      input: source as NodeJS.ReadStream,
      interactive: false,
      expand: (line) => line,
      dispose: () => {},
    };
  }

  const paste = new PasteInput(source as NodeJS.ReadStream, options);
  return {
    input: paste as unknown as NodeJS.ReadStream,
    interactive: true,
    expand: (line) => paste.expand(line),
    dispose: () => paste.dispose(),
  };
}

/**
 * 临时关闭某个输入流上的粘贴折叠。
 *
 * 选择器与隐藏输入拿到的可能是真正的 stdin（测试里就是这样），
 * 这时没有可关闭的东西，返回一个空操作即可。
 */
export function suspendPasteCollapse(input: unknown): () => void {
  const target = input as { suspendCollapse?: () => () => void } | null | undefined;
  if (!target || typeof target.suspendCollapse !== "function") {
    return () => {};
  }
  return target.suspendCollapse();
}
