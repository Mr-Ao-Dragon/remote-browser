import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ags } = require("tencentcloud-sdk-nodejs-ags");

const URL_BASE = process.env.RB_URL || "http://127.0.0.1:8791/mcp";
const TOOL_ID = process.env.RB_TOOL_ID || "";
const TOOL_NAME = process.env.RB_TOOL_NAME || "remote-browser";
const REGION = process.env.TC_REGION || "ap-shanghai";
const IDLE_WAIT = Number(process.env.RB_IDLE_WAIT || 30000);

function loadCreds() {
  const p = process.env.TC_CRED_FILE || path.join(os.homedir(), "Downloads", "SecretKey (1).csv");
  const lines = fs.readFileSync(p, "utf8").trim().split(/\r?\n/);
  const header = lines[0].split(",").map((s) => s.trim());
  const row = lines[1].split(",").map((s) => s.trim());
  return {
    secretId: row[header.findIndex((h) => /secretid/i.test(h))],
    secretKey: row[header.findIndex((h) => /secretkey/i.test(h))],
  };
}

const agsClient = new ags.v20250920.Client({
  credential: loadCreds(),
  region: REGION,
  profile: { httpProfile: { endpoint: "ags.tencentcloudapi.com", reqTimeout: 40 } },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPaused(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await snap();
    const running = last.filter((i) => i.status === "RUNNING" || i.status === "PAUSING").length;
    if (running === 0 && last.some((i) => i.status === "PAUSED")) return last;
    await sleep(2000);
  }
  return last;
}
const j = (r) => JSON.parse((r.content || []).find((c) => c.type === "text").text);

let resolvedIds;
async function toolIds() {
  if (TOOL_ID) return [TOOL_ID];
  if (resolvedIds) return resolvedIds;
  const r = await agsClient.DescribeSandboxToolList({ Limit: 100 });
  resolvedIds = (r.SandboxToolSet || []).filter((t) => t.ToolName === TOOL_NAME).map((t) => t.ToolId);
  return resolvedIds;
}

async function snap() {
  const ids = await toolIds();
  const r = await agsClient.DescribeSandboxInstanceList({ Limit: 100 });
  return (r.InstanceSet || [])
    .filter((i) => ids.includes(i.ToolId))
    .map((i) => ({ id: i.InstanceId.slice(0, 8), status: i.Status, stop: i.StopReason }));
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail ? JSON.stringify(detail) : ""}`);
}

const client = new Client({ name: "lifecycle", version: "1.0.0" }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_BASE)));

// 1. 首次导航
const nav1 = j(await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com" } }));
const s1 = await snap();
check("首次调用创建运行实例", nav1.ok && s1.some((i) => i.status === "RUNNING"), { instances: s1 });

// 2. 空闲等待 → 应暂停（默认 idleAction=PAUSE），实例不消失
console.log(`waiting ${IDLE_WAIT}ms for idle sweep...`);
await sleep(IDLE_WAIT);
const s2 = await waitPaused();
check(
  "空闲后实例暂停而非运行",
  s2.length > 0 && s2.every((i) => i.status !== "RUNNING") && s2.some((i) => i.status === "PAUSED"),
  { instances: s2 }
);

// 3. 再次调用 → 复用同一实例恢复，而不是新建
const wait2 = j(await client.callTool({ name: "browser_wait", arguments: { selector: "body", timeoutMs: 8000 } }));
const s3 = await snap();
check(
  "恢复同一实例且页面状态保留",
  wait2.ok && s3.filter((i) => i.status === "RUNNING").length === 1 && s3.every((i) => s2.some((p) => p.id === i.id)),
  { wait: wait2, instances: s3 }
);

// 4. persistState=true 时，空闲同样暂停，再恢复
const nav2 = j(
  await client.callTool({ name: "browser_navigate", arguments: { url: "https://www.iana.org/help/example-domains", persistState: true } })
);
await sleep(IDLE_WAIT);
const s4 = await waitPaused();
const resumed = j(await client.callTool({ name: "browser_wait", arguments: { selector: "body", timeoutMs: 8000 } }));
check(
  "persistState=true 会话暂停后可恢复且 URL 保持",
  nav2.ok && s4.some((i) => i.status === "PAUSED") && resumed.ok && resumed.url.includes("iana.org"),
  { paused: s4, resumed }
);

// 5. 关闭
await client.callTool({ name: "browser_close", arguments: {} });
await client.close();
await sleep(3000);
const s5 = await snap();
check("close 后无运行实例", s5.every((i) => i.status !== "RUNNING"), { instances: s5 });

const failed = results.filter((r) => !r.ok);
console.log("\n==== summary ====");
console.log(JSON.stringify({ total: results.length, failed: failed.map((f) => f.name) }, null, 2));
process.exit(failed.length ? 1 : 0);