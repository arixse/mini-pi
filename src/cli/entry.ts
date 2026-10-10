#!/usr/bin/env node
/**
 * CLI 可执行入口
 *
 * 仅负责启动 main()。为避免 import 副作用（曾导致单元测试 import 时
 * 启动 REPL 占住 stdin 而挂起），所有业务逻辑都在 ./index.ts 中导出，
 * 本文件不做任何业务实现，单元测试也不会 import 本文件。
 */
import { main } from "./index";
import { logger } from "../shared/logger";

main().catch((error) => {
  logger.error(error);
  process.exit(1);
});
