#!/usr/bin/env node

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, "..", "src", "cli", "index.ts");

try {
  execSync(`npx tsx "${cliPath}"`, {
    stdio: "inherit",
    cwd: process.cwd(),
  });
} catch (error) {
  process.exit(1);
}