`src/flags.mjs` 目前只支持总开关。请扩展 `isEnabled(flag, user, config)`：

1. `config[flag]` 不存在或 `enabled !== true` 时返回 `false`。
2. `rule.allow` 是数组且包含 `user.id` 时返回 `true`（仍要求 `enabled === true`）。
3. `rule.rollout` 是整数 0–100 时按灰度返回：
   - 计算 `bucket = [...`${flag}:${user.id}`].reduce((sum, ch) => sum + ch.codePointAt(0), 0) % 100`；
   - `bucket < rollout` 返回 `true`，否则 `false`；
   - `user` 或 `user.id` 缺失时返回 `false`；
   - `rollout` 不是 0–100 的整数时返回 `false`。
4. `rule.rollout` 未配置时，`enabled === true` 即返回 `true`。

不要修改既有导出的函数签名。
