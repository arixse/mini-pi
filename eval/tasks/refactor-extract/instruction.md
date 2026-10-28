`src/report.mjs` 里两处重复拼接显示名。请做一次**行为不变**的重构：

1. 新建 `src/name.mjs`，导出 `displayName(user)`，返回 `"${user.lastName}, ${user.firstName}"`；
2. `formatUser` 与 `formatAdmin` 都改为使用 `displayName`；
3. 两个函数的输出、导出名与调用方式保持不变；
4. `test/` 下既有测试与 `grade/` 隐藏测试都要通过。

不要顺手改文案、空格或大小写。不要修改 `test/` 下的文件。
