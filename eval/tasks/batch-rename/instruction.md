`src/util.mjs` 里的共享函数 `legacyFormat` 名字已经过时。请把它重命名为 `formatValue`：

1. 修改 `src/util.mjs` 的导出名；
2. 更新 `src/a.mjs` 到 `src/h.mjs` 这 8 个模块的 import 与调用；
3. `formatA` … `formatH` 的导出名与行为保持不变；
4. 重命名后 `src/` 下不应再出现 `legacyFormat`；
5. `test/` 下既有测试与 `grade/` 隐藏测试都要通过。

不要修改 `test/` 下的文件。
