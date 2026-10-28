/**
 * 功能开关判定。
 *
 * 现状只支持总开关；灰度比例与白名单还没实现。
 */
export function isEnabled(flag, user, config = {}) {
  const rule = config[flag];
  return Boolean(rule && rule.enabled === true);
}
