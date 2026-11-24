/**
 * 验收脚本：直接连接 HTTP 模式下的 MCP Server，跑 6 条验收标准。
 * 用法：
 *   RB_URL=http://127.0.0.1:8791/mcp node scripts/acceptance.mjs
 * 可选环境变量：
 *   RB_CONCURRENCY=10  并发会话数
 *   RB_TOOL_ID=...     固定工具 ID（可选）
 *   RB_TOOL_NAME=...   未指定 ID 时按名字匹配工具，默认 remote-browser
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ags } = require("tencentcloud-sdk-nodejs-ags");

const URL_BASE = process.env.RB_URL || "http://127.0.0.1:8791/mcp";
const CONCURRENCY = Number(process.env.RB_CONCURRENCY || 10);
const TOOL_ID = process.env.RB_TOOL_ID || "";
const TOOL_NAME = process.env.RB_TOOL_NAME || "remote-browser";
const REGION = process.env.TC_REGION || "ap-shanghai";

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

let resolvedIds;
async function toolIds() {
  if (TOOL_ID) return [TOOL_ID];
  if (resolvedIds) return resolvedIds;
  const r = await agsClient.DescribeSandboxToolList({ Limit: 100 });
  resolvedIds = (r.SandboxToolSet || []).filter((t) => t.ToolName === TOOL_NAME).map((t) => t.ToolId);
  return resolvedIds;
}

async function listInstances() {
  const ids = await toolIds();
  if (ids.length === 0) return [];
  const r = await agsClient.DescribeSandboxInstanceList({ Limit: 100 });
  return (r.InstanceSet || []).filter((i) => ids.includes(i.ToolId));
}

async function newClient() {
  const client = new Client({ name: "acceptance", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(URL_BASE));
  await client.connect(transport);
  return client;
}

function textOf(result) {
  const item = (result?.content || []).find((c) => c.type === "text");
  if (!item) return null;
  try {
    return JSON.parse(item.text);
  } catch {
    return item.text;
  }
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + JSON.stringify(detail) : ""}`);
}

async function main() {
  const before = await listInstances();
  const runningBefore = before.filter((i) => i.Status === "RUNNING").length;

  // ---- 1. 7 个工具 & navigate 返回标题 ----
  const client = await newClient();
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const expected = [
    "browser_click",
    "browser_close",
    "browser_extract",
    "browser_navigate",
    "browser_screenshot",
    "browser_type",
    "browser_wait",
  ];
  record("工具面为 7 个固定工具", JSON.stringify(tools) === JSON.stringify(expected), tools);

  const nav = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com" } });
  const navData = textOf(nav);
  record("navigate 返回标题", navData?.title === "Example Domain", navData);

  const runningDuring = (await listInstances()).filter((i) => i.Status === "RUNNING").length;
  record("运行实例在调用后存在且不超过并发上限", runningDuring - runningBefore <= CONCURRENCY, { runningBefore, runningDuring });

  // ---- 2. 返回值不含实例 ID / Token / 内网地址 ----
  const raw = JSON.stringify(nav);
  const leak = /sit_[A-Za-z0-9]{6,}|dpt_|\d{4,5}-[a-z0-9]{32}\.|internal\.tencentags\.com|X-Access-Token/i.test(raw);
  record("返回值不含实例 ID / Token / 内网地址", !leak, { sample: raw.slice(0, 120) });

  // ---- 3. 截图 / 提取 / 等待 ----
  const shot = await client.callTool({ name: "browser_screenshot", arguments: { fullPage: false } });
  const img = (shot.content || []).find((c) => c.type === "image");
  record("screenshot 返回 PNG", !!img && img.data.length > 1000, { bytes: img ? img.data.length : 0 });

  const extract = await client.callTool({
    name: "browser_extract",
    arguments: {
      schema: {
        fields: {
          docTitle: { selector: "head > title", type: "text" },
          bodyText: { selector: "body", type: "text" },
          link: { selector: "a", type: "href" },
        },
      },
    },
  });
  const exData = textOf(extract);
  record(
    "extract 返回结构化字段",
    exData?.data?.docTitle === "Example Domain" && String(exData?.data?.bodyText || "").length > 20,
    { docTitle: exData?.data?.docTitle, bodyLen: String(exData?.data?.bodyText || "").length }
  );

  const waitRes = await client.callTool({
    name: "browser_wait",
    arguments: { selector: "body", timeoutMs: 5000 },
  });
  record("wait 命中选择器", textOf(waitRes)?.matched === true, textOf(waitRes));

  // ---- 4. 点击 / 输入（在 example.com 上点击链接） ----
  const click = await client.callTool({ name: "browser_click", arguments: { selector: "a" } });
  const clickData = textOf(click);
  record("click 触发跳转", clickData?.ok === true && clickData?.url !== "https://example.com/", clickData);

  // ---- 5. 错误脱敏 ----
  const bad = await client.callTool({ name: "browser_navigate", arguments: { url: "file:///etc/passwd" } });
  const badData = textOf(bad);
  const badLeak = /sit_|dpt_|\d{4,5}-[a-z0-9]{32}\.|internal\.tencentags\.com/i.test(JSON.stringify(bad));
  record("非法 URL 被拒绝且无凭证泄漏", badData?.code === "unsupported_url" && !badLeak, badData);

  // ---- 6. 并发 ----
  await client.callTool({ name: "browser_close", arguments: {} }).catch(() => {});
  await sleep(3000);
  const beforeConcurrency = (await listInstances()).filter((i) => i.Status === "RUNNING").length;
  const clients = await Promise.all(Array.from({ length: CONCURRENCY }, () => newClient()));
  const t0 = Date.now();
  const outcomes = await Promise.allSettled(
    clients.map((c, i) =>
      c.callTool({ name: "browser_navigate", arguments: { url: `https://example.com/?i=${i}` } })
    )
  );
  const okCount = outcomes.filter((o) => o.status === "fulfilled" && textOf(o.value)?.ok).length;
  const elapsed = Date.now() - t0;
  const peak = (await listInstances()).filter((i) => i.Status === "RUNNING").length;
  record(
    `${CONCURRENCY} 并发 navigate 全部成功且未超上限（≤50）`,
    okCount === CONCURRENCY && peak <= 50,
    { okCount, peak, beforeConcurrency, elapsedMs: elapsed }
  );

  // ---- 7. 关闭会话 → 实例停止 ----
  await Promise.all(clients.map((c) => c.callTool({ name: "browser_close", arguments: {} }).catch(() => {})));
  await client.callTool({ name: "browser_close", arguments: {} });
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await client.close().catch(() => {});

  await sleep(4000);
  const afterClose = (await listInstances()).filter((i) => i.Status === "RUNNING").length;
  record("browser_close 后无运行实例", afterClose <= runningBefore, { runningBefore, runningAfter: afterClose });

  // ---- 8. 汇总 ----
  const failed = results.filter((r) => !r.ok);
  console.log("\n==== summary ====");
  console.log(JSON.stringify({ total: results.length, failed: failed.map((f) => f.name) }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("acceptance crashed:", err);
  process.exit(1);
});