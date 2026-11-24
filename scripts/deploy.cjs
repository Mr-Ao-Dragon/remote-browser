#!/usr/bin/env node
/**
 * 一键准备沙箱工具（路线 B：MCP Server 自管实例生命周期）。
 *
 * 作用：按 remote-browser 需要的镜像 / 启动脚本 / 端口 / 探针创建（或复用）
 *      一个非持久沙箱工具，并打印 MCP Server 需要的环境变量。
 *
 * 用法：
 *   node scripts/deploy.cjs                 # 创建或复用同名工具
 *   node scripts/deploy.cjs --dry-run       # 只打印将提交的参数
 *   node scripts/deploy.cjs --name my-tool  # 指定工具名
 *   node scripts/deploy.cjs --list          # 列出现有工具
 *
 * 环境变量：
 *   TC_REGION / TC_SECRET_ID / TC_SECRET_KEY / TC_CRED_FILE / TC_ROLE_ARN
 *   RB_TOOL_TIMEOUT   工具默认超时（5m 起）
 *   RB_SANDBOX_PORT   沙箱内 CDP 代理端口，默认 9000
 *
 * 安全约束：不打印 SecretId / SecretKey / Token；工具 ID 不是凭证，可以打印。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ags } = require("tencentcloud-sdk-nodejs-ags");
const { AbstractClient } = require("tencentcloud-sdk-nodejs-common");

const REGION = process.env.TC_REGION || "ap-shanghai";
const PORT = Number(process.env.RB_SANDBOX_PORT || 9000);
const TIMEOUT = process.env.RB_TOOL_TIMEOUT || "5m";
const IMAGE = process.env.RB_IMAGE || "ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DRY_RUN = has("--dry-run");
const LIST_ONLY = has("--list");
const TOOL_NAME = valueOf("--name", process.env.RB_TOOL_NAME || "remote-browser");

const CHROME_FLAGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--window-size=1440,900",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=9222",
  "--user-data-dir=/tmp/cdpprofile",
].join(" ");

const BOOTSTRAP_SCRIPT = [
  "set -u;",
  "C=$(command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable);",
  'if [ -z "$C" ]; then echo "remote-browser: chromium not found" >&2; exit 1; fi;',
  "mkdir -p /tmp/cdpprofile;",
  `( while true; do "$C" ${CHROME_FLAGS} about:blank >> /tmp/chrome.log 2>&1; sleep 1; done ) &`,
  "exec sleep infinity",
].join(" ");

const CUSTOM_CONFIGURATION = {
  Image: IMAGE,
  ImageRegistryType: "custom",
  Command: ["/init"],
  Args: ["/bin/sh", "-c", BOOTSTRAP_SCRIPT],
  Ports: [{ Name: "web", Port: PORT, Protocol: "TCP" }],
  Resources: { CPU: "2", Memory: "4Gi" },
  Probe: {
    HttpGet: { Path: "/", Port: PORT, Scheme: "HTTP" },
    ReadyTimeoutMs: 30000,
    ProbeTimeoutMs: 3000,
    ProbePeriodMs: 2000,
    SuccessThreshold: 1,
    FailureThreshold: 10,
  },
};

function fail(message) {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

function readCredentialFile(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) fail("凭证文件格式无法识别");
  const header = lines[0].split(",").map((s) => s.trim());
  const row = lines[1].split(",").map((s) => s.trim());
  const secretId = row[header.findIndex((h) => /secretid/i.test(h))];
  const secretKey = row[header.findIndex((h) => /secretkey/i.test(h))];
  if (!secretId || !secretKey) fail("凭证文件缺少 SecretId 或 SecretKey");
  return { secretId, secretKey };
}

async function resolveCredential() {
  let base;
  if (process.env.TC_SECRET_ID && process.env.TC_SECRET_KEY) {
    base = { secretId: process.env.TC_SECRET_ID, secretKey: process.env.TC_SECRET_KEY };
  } else {
    const file = process.env.TC_CRED_FILE || path.join(os.homedir(), "Downloads", "SecretKey (1).csv");
    if (!fs.existsSync(file)) fail("未找到凭证：请设置 TC_SECRET_ID / TC_SECRET_KEY 或 TC_CRED_FILE");
    base = readCredentialFile(file);
  }
  if (!process.env.TC_ROLE_ARN) return base;

  const sts = new AbstractClient("sts.tencentcloudapi.com", "2018-08-13", {
    credential: base,
    region: REGION,
    profile: { httpProfile: { reqTimeout: 30 }, signMethod: "TC3-HMAC-SHA256" },
  });
  const res = await sts.request("AssumeRole", {
    RoleArn: process.env.TC_ROLE_ARN,
    RoleSessionName: process.env.TC_ROLE_SESSION_NAME || "remote-browser",
    DurationSeconds: 3600,
  });
  const body = res && res.Credentials ? res : res && res.Response;
  if (!body || !body.Credentials) fail("AssumeRole 未返回临时凭证");
  console.log("已通过 AssumeRole 换取临时凭证");
  return {
    secretId: body.Credentials.TmpSecretId,
    secretKey: body.Credentials.TmpSecretKey,
    token: body.Credentials.Token,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitActive(client, toolId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.DescribeSandboxToolList({ Limit: 100 });
    const tool = (res.SandboxToolSet || []).find((t) => t.ToolId === toolId);
    if (tool && tool.Status === "ACTIVE") return tool;
    if (tool && tool.Status === "FAILED") fail(`工具创建失败：${tool.StatusReason || "未知原因"}`);
    await sleep(3000);
  }
  fail("等待工具就绪超时（180s）");
}

function printEnv(tool) {
  console.log("\n==== MCP Server 环境变量 ====");
  console.log("# 预热模式（固定工具，不随进程回收）");
  console.log(`RB_TOOL_ID=${tool.ToolId}`);
  console.log(`TC_REGION=${REGION}`);
  console.log("RB_TRANSPORT=STDIO");
  console.log("\n# 默认懒创建模式：不设 RB_TOOL_ID 即可，首次调用时自动建工具");
  console.log("# 可选回收：RB_TOOL_IDLE_MS=3600000（空闲 1h 删工具）  RB_TOOL_DELETE_ON_EXIT=1（退出时删）");
  console.log("\n# MCP 客户端配置片段（stdio，懒创建）");
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          "remote-browser": {
            command: "node",
            args: [path.resolve(__dirname, "..", "dist", "index.js")],
            env: { TC_REGION: REGION, RB_TRANSPORT: "STDIO" },
          },
        },
      },
      null,
      2
    )
  );
  console.log("\n提示：凭证放在本机环境变量或 TC_CRED_FILE 中，不要写进上面的配置。");
}

(async () => {
  const credential = await resolveCredential();
  const client = new ags.v20250920.Client({
    credential,
    region: REGION,
    profile: { httpProfile: { endpoint: "ags.tencentcloudapi.com", reqTimeout: 60 }, signMethod: "TC3-HMAC-SHA256" },
  });

  const list = await client.DescribeSandboxToolList({ Limit: 100 });
  const tools = list.SandboxToolSet || [];

  if (LIST_ONLY) {
    console.log(JSON.stringify(tools.map((t) => ({ ToolId: t.ToolId, ToolName: t.ToolName, Status: t.Status, Persistent: t.Persistent })), null, 2));
    return;
  }

  const existing = tools.find((t) => t.ToolName === TOOL_NAME);
  if (existing) {
    console.log(`复用已有工具 ${existing.ToolName}（${existing.ToolId}，状态 ${existing.Status}）`);
    if (existing.Status !== "ACTIVE") {
      console.log("工具未就绪，等待中…");
      await waitActive(client, existing.ToolId);
    }
    printEnv(existing);
    return;
  }

  const body = {
    ToolName: TOOL_NAME,
    ToolType: "custom",
    Description: "remote-browser: ephemeral chromium sandbox (CDP on 9000/cdp)",
    NetworkConfiguration: { NetworkMode: "PUBLIC" },
    DefaultTimeout: TIMEOUT,
    Persistent: false,
    CustomConfiguration: CUSTOM_CONFIGURATION,
  };

  if (DRY_RUN) {
    console.log("dry-run，将提交以下参数：");
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`创建沙箱工具 ${TOOL_NAME}（镜像 ${IMAGE}）…`);
  const created = await client.CreateSandboxTool(body);
  if (!created.ToolId) fail("创建工具未返回 ToolId");
  console.log(`已提交，ToolId=${created.ToolId}，等待 ACTIVE…`);
  const tool = await waitActive(client, created.ToolId);
  console.log(`工具就绪：${tool.ToolName}（${tool.ToolId}）`);
  printEnv(tool);
})().catch((err) => {
  const code = (err && err.code) || "";
  const message = (err && err.message) || String(err);
  console.error(`deploy 失败：${code} ${message}`.slice(0, 300));
  process.exit(1);
});