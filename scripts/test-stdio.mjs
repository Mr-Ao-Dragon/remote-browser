/**
 * stdio 传输冒烟：以子进程方式拉起 MCP Server，走完整工具链。
 * 默认走「工具懒创建 + 退出删除」路径；指定 RB_TOOL_ID 时改为验证固定工具。
 *
 *   node scripts/test-stdio.mjs                    # 懒创建模式
 *   RB_TOOL_ID=sdt-xxxx node scripts/test-stdio.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ags } = require("tencentcloud-sdk-nodejs-ags");

const TOOL_ID = process.env.RB_TOOL_ID || "";
const TOOL_NAME = process.env.RB_TOOL_NAME || "remote-browser-smoke";
const REGION = process.env.TC_REGION || "ap-shanghai";
const LAZY = !TOOL_ID;

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

async function toolIds() {
  if (TOOL_ID) return [TOOL_ID];
  const r = await agsClient.DescribeSandboxToolList({ Limit: 100 });
  return (r.SandboxToolSet || []).filter((t) => t.ToolName === TOOL_NAME).map((t) => t.ToolId);
}

async function countRunning() {
  const ids = await toolIds();
  if (ids.length === 0) return 0;
  const r = await agsClient.DescribeSandboxInstanceList({ Limit: 100 });
  return (r.InstanceSet || []).filter((i) => ids.includes(i.ToolId) && i.Status === "RUNNING").length;
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail ? JSON.stringify(detail) : ""}`);
};

function textOf(result) {
  const item = (result?.content || []).find((c) => c.type === "text");
  if (!item) return null;
  try {
    return JSON.parse(item.text);
  } catch {
    return item.text;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/index.js")],
    env: {
      ...process.env,
      RB_TRANSPORT: "STDIO",
      RB_TOOL_ID: TOOL_ID,
      RB_TOOL_NAME: TOOL_NAME,
      RB_TOOL_DELETE_ON_EXIT: LAZY ? "1" : "0",
      RB_LOG_LEVEL: process.env.RB_LOG_LEVEL || "warn",
      RB_IDLE_MS: process.env.RB_IDLE_MS || "90000",
    },
    stderr: "pipe",
  });
  let stderrBuf = "";
  transport.stderr?.on("data", (chunk) => (stderrBuf += chunk.toString()));

  const client = new Client({ name: "stdio-smoke", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  check("stdio 握手成功", true);

  const tools = await client.listTools();
  const names = (tools.tools || []).map((t) => t.name).sort();
  check("工具面为 7 个固定工具", names.length === 7, names);

  const navRaw = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com/" } });
  if (process.env.RB_TEST_RAW) console.log("RAW navigate:", JSON.stringify(navRaw, null, 2));
  const nav = textOf(navRaw);
  check("navigate 返回标题", nav?.ok === true && !!nav?.title, { title: nav?.title, url: nav?.url });

  const shot = await client.callTool({ name: "browser_screenshot", arguments: {} });
  const png = (shot?.content || []).find((c) => c.type === "image");
  const bytes = png ? Math.floor((png.data || "").length * 0.75) : 0;
  check("screenshot 返回 PNG", bytes > 1000, { bytes });

  await client.callTool({ name: "browser_close", arguments: {} });
  await sleep(1500);
  const running = await countRunning();
  check("close 后无运行中的实例", running === 0, { running });

  // 脱敏检查：stderr 不得出现凭证/Token/内网地址
  const leaks = [];
  const patterns = [
    /sit_[A-Za-z0-9]{10,}/,
    /dpt_[A-Za-z0-9]{10,}/,
    /AKID[A-Za-z0-9]{10,}/,
    /\.internal\.tencentags\.com/,
    /X-Access-Token["':\s]+[A-Za-z0-9_\-]{10,}/i,
    new RegExp(`\\d{4,5}-[a-z0-9]{20,}\\.${REGION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.tencentags\\.com`),
  ];
  for (const p of patterns) {
    const m = stderrBuf.match(p);
    if (m) leaks.push(m[0].slice(0, 24));
  }
  check("stderr 无凭证/Token/内网地址泄漏", leaks.length === 0, leaks.length ? leaks : undefined);

  await client.close();

  if (LAZY) {
    await sleep(4000);
    if (process.env.RB_TEST_RAW) console.log("STDERR:\n" + stderrBuf);
    const remaining = await toolIds();
    check("退出后工具已回收", remaining.length === 0, { remaining });
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n==== summary ====");
  console.log(JSON.stringify({ total: results.length, failed: failed.map((f) => f.name) }, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("FATAL", err?.stack || err);
  process.exit(1);
});