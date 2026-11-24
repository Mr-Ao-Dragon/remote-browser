/**
 * 冒烟：用真实的 dsh-mcp-client 拉起 dist/index.js，确认 7 个工具被发现并完成命名。
 * 不调用任何工具，因此不会访问腾讯云；凭证用临时 CSV 占位。
 *
 * 运行：node integrations/deepseek-harness/smoke.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import * as plugin from "./index.js";

const EXPECTED = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_extract",
  "browser_wait",
  "browser_close",
];

class ToolRegistry extends Service {
  constructor(ctx) {
    super(ctx, "tools");
    this.entries = new Map();
  }

  register(definition) {
    this.entries.set(definition.name, definition);
    return () => this.entries.delete(definition.name);
  }
}

const credDir = await mkdtemp(join(tmpdir(), "rb-dsh-smoke-"));
const credFile = join(credDir, "dummy-cred.csv");
await writeFile(credFile, "SecretId,SecretKey\nAKIDdummy,skdummy\n", "utf8");
process.env.TC_CRED_FILE = credFile;

const root = new Context();
try {
  await root.plugin(ToolRegistry);
  await root.plugin(plugin, { serverName: "smoke" });

  const names = [...root.tools.entries.keys()].sort();
  for (const raw of EXPECTED) {
    assert.ok(names.includes(`mcp__smoke__${raw}`), `缺少工具 ${raw}，实际：${names.join(", ")}`);
  }
  assert.equal(names.length, EXPECTED.length, `工具数量应为 ${EXPECTED.length}，实际 ${names.length}`);
  console.log(names.join("\n"));
  console.log(`\nsmoke OK: ${names.length} tools discovered`);
} finally {
  await root.fiber.dispose();
}