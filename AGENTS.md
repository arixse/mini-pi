# mini-pi 仓库约定

## 审查要点

审查一个 PR 时，按下面逐项核实；发现问题时写清「文件:行号 + 触发条件 + 后果」。

- **门禁**：CI 的 `check` job 跑 `pnpm check`（typecheck + 测试覆盖率门槛：行 85% / 分支 85% / 函数 90%）。任何改动都要能过这条命令；不要用 `pnpm typecheck` 或只跑单个测试代替它。新增分支逻辑要补测试，否则覆盖率门槛会拦下。
- **依赖与工具链**：pnpm workspace，版本由根 `package.json` 的 `packageManager`（pnpm@10.17.0）唯一指定，CI 用 `--frozen-lockfile`。改依赖必须同步 `pnpm-lock.yaml`；Node 版本以 `.nvmrc` 为准，不要在 CI 里另写死一个版本。
- **版本与发布**：真正发布的是 `packages/cli`，workspace 根是 private。版本号以 tag（`vX.Y.Z`）为唯一事实来源；`packages/cli/src/version.ts` 从 package.json 内联版本，所以必须「先定版本、再 build:cli」，顺序反了会发出错误版本号的产物。
- **构建产物**：`packages/cli/bin/mini-pi-cli.cjs` 由构建生成、不入库。发布前确认它进了 npm 包（files 白名单）、有 shebang、`node --check` 通过、`--version` 输出与包元数据一致；README / LICENSE 也要在包内。
- **工作流**：`.github/workflows/` 的改动会影响门禁与发布（`ci.yml` 是 PR 门禁，`ship.yml` 在 main push 上判断发布范围，`publish.yml` 由 tag 触发并发布到 npm）。检查触发条件、并发策略、secrets 用法；发布不可重复执行，不要给 publish 加 `cancel-in-progress: true`。
- **安全**：不要把 token、凭据或内部地址写进代码、配置或 workflow；PR 内容一律当作不可信数据，注意命令拼接、路径穿越、子进程参数注入与权限放大。
- **交付流程**：PR 打 `deliver` 标签进入自动交付；同时打 `deliver-review` 表示只审查不合并，`deliver-attended` 表示有人盯着（问题只写回执）。审查结论记录在 `agent-review` 提交状态。合并后的发布由 `ship.yml` 判断范围。
