/**
 * 版本号比较：判断"registry 上的最新版是否比当前版本新"。
 *
 * 单独成模块而不是塞进 updateCheck.ts：比较规则本身（prerelease、
 * build metadata、缺位的 minor/patch）是纯数学，值得被单独测透；
 * 而更新检测还掺着网络、缓存与开关，混在一起会让"1.0.0-beta < 1.0.0"
 * 这种基本断言跟着 IO 一起跑。
 *
 * 刻意不做完整 semver 库：CLI 只需要回答一个是/否问题，而依赖一个
 * semver 包会进 esbuild 产物（发布包只有 bin 单文件，能不带的都不带）。
 */

/** 形如 `1.2.3` / `1.2.3-beta.1` / `1.2.3+build5` 的版本号 */
const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** 是否是可直接比较的版本号（registry 回怪值时不至于把"latest"当成版本） */
export function isSemver(version: string): boolean {
  return SEMVER_PATTERN.test(version.trim());
}

type ParsedVersion = {
  /** 主/次/修订号，缺位补 0 */
  core: [number, number, number];
  /** prerelease 标识段（`1.0.0-beta.1` → ["beta","1"]）；正式版为空数组 */
  prerelease: string[];
};

/** 拆版本号：剥 `v`/`=` 前缀，丢 build metadata，其余按 semver 规则切段 */
function parseVersion(raw: string): ParsedVersion {
  const withoutPrefix = raw.trim().replace(/^[vV=]+/, "");
  // build metadata（`+` 之后）不参与比较：1.0.0+build1 与 1.0.0 同版本
  const [coreAndPre] = withoutPrefix.split("+");
  const [corePart, ...preParts] = coreAndPre.split("-");
  const core = corePart
    .split(".")
    .map((part) => {
      const value = Number.parseInt(part, 10);
      // 非数字段（空串、"x"）按 0 处理：调用方已用 isSemver 挡掉怪值，
      // 这里只是不抛异常的兜底
      return Number.isFinite(value) && value >= 0 ? value : 0;
    });
  while (core.length < 3) {
    core.push(0);
  }
  return {
    core: [core[0] ?? 0, core[1] ?? 0, core[2] ?? 0],
    prerelease: preParts.length > 0 ? preParts.join("-").split(".").filter(Boolean) : [],
  };
}

/**
 * 比较 prerelease 段（semver 第 11 条）。
 *
 * 三条规则：无 prerelease 者更大（`1.0.0` > `1.0.0-beta`）；
 * 数字标识按数值比、且小于字母标识（`1.0.0-1` < `1.0.0-alpha`）；
 * 前缀相同则段多者更大（`1.0.0-alpha` < `1.0.0-alpha.1`）。
 */
function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) {
      return -1;
    }
    if (b === undefined) {
      return 1;
    }
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) {
        return diff < 0 ? -1 : 1;
      }
      continue;
    }
    // 数字标识 < 字母标识
    if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    }
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 比较两个版本号：`a < b` 返回 -1，相等 0，`a > b` 返回 1。
 *
 * 入参假定已是版本号形状（调用前用 {@link isSemver} 挡一道）；
 * 对 `1.2` 这类缺位写法按补 0 处理，不抛异常。
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * latest 是否比 current 更新。
 *
 * 任一侧不是版本号形状时返回 false：registry 被镜像/代理改了返回值时，
 * "猜一个大小"比"不提示"更危险——用户会看到一条从没发布过的版本号。
 */
export function isNewerVersion(latest: string, current: string): boolean {
  if (!isSemver(latest) || !isSemver(current)) {
    return false;
  }
  return compareVersions(latest, current) > 0;
}

/**
 * 从 registry 响应里取最新版本号。
 *
 * `/{包名}/latest` 的响应两种形状都收：packument 的 `version` 字段与
 * `dist-tags.latest`。取不到合法版本号时返回 null（由调用方按
 * "检查失败"处理），绝不返回一个猜出来的值。
 */
export function parseLatestVersion(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") {
    return null;
  }
  const record = payload as {
    version?: unknown;
    "dist-tags"?: { latest?: unknown };
  };
  for (const candidate of [record.version, record["dist-tags"]?.latest]) {
    if (typeof candidate === "string" && isSemver(candidate)) {
      return candidate.trim();
    }
  }
  return null;
}
