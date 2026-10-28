/**
 * 功能开关判定：总开关 → 白名单 → 灰度比例。
 */
function bucket(flag, userId) {
  return [...`${flag}:${userId}`].reduce((sum, ch) => sum + ch.codePointAt(0), 0) % 100;
}

export function isEnabled(flag, user, config = {}) {
  const rule = config[flag];
  if (!rule || rule.enabled !== true) {
    return false;
  }
  const userId = user?.id;
  if (Array.isArray(rule.allow) && userId !== undefined && rule.allow.includes(userId)) {
    return true;
  }
  if (rule.rollout === undefined) {
    return true;
  }
  if (!Number.isInteger(rule.rollout) || rule.rollout < 0 || rule.rollout > 100) {
    return false;
  }
  if (userId === undefined) {
    return false;
  }
  return bucket(flag, userId) < rule.rollout;
}
