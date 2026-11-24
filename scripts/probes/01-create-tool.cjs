/**
 * 探针 01：创建 browser 沙箱工具（Persistent=true，部署绑定的硬要求）
 * 幂等：已存在同名前缀且 ACTIVE 的工具则复用。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const TOOL_NAME = process.env.TC_TOOL_NAME || "rb-probe-browser";

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

const cred = loadCreds();
const Client = tc.ags.v20250920.Client;
const client = new Client({
  credential: cred,
  region: REGION,
  profile: { httpProfile: { endpoint: "ags.tencentcloudapi.com", reqTimeout: 30 } },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: e?.message || String(e) });

async function findTool() {
  const r = await client.DescribeSandboxToolList({ Limit: 100 });
  return (r.SandboxToolSet || []).find((t) => t.ToolName === TOOL_NAME);
}

async function waitActive(toolId, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await client.DescribeSandboxToolList({ ToolIds: [toolId], Limit: 10 });
    const t = (r.SandboxToolSet || [])[0];
    if (t && t.Status === "ACTIVE") return t;
    if (t && t.Status === "FAILED") throw new Error(`tool FAILED: ${JSON.stringify(t)}`);
    await sleep(3000);
  }
  throw new Error("tool active timeout");
}

(async () => {
  let tool = await findTool();
  let created = false;

  if (!tool) {
    const r = await client.CreateSandboxTool({
      ToolName: TOOL_NAME,
      ToolType: process.env.TC_TOOL_TYPE || "browser",
      NetworkConfiguration: { NetworkMode: "PUBLIC" },
      // browser 类型不支持 Persistent；部署探针必须用 custom
      ...(process.env.TC_PERSISTENT === "true" ? { Persistent: true } : {}),
      ...(process.env.TC_IMAGE
        ? {
            CustomConfiguration: {
              Image: process.env.TC_IMAGE,
              ImageRegistryType: process.env.TC_IMAGE_REGISTRY_TYPE || "enterprise",
              Ports: [
                { Name: "http", Port: 9000, Protocol: "TCP" },
                { Name: "envd", Port: 49983, Protocol: "TCP" },
              ],
              Resources: { CPU: "2", Memory: "2Gi" },
              Probe: {
                HttpGet: { Path: "/health", Port: 49983, Scheme: "HTTP" },
                ReadyTimeoutMs: 60000,
                ProbeTimeoutMs: 3000,
                ProbePeriodMs: 2000,
                SuccessThreshold: 1,
                FailureThreshold: 30,
              },
            },
          }
        : {}),
      DefaultTimeout: "10m",
      Description: "remote-browser probe",
      ClientToken: `rb-probe-tool-${REGION}-${process.env.TC_TOOL_NAME || "default"}`,
    });
    created = true;
    tool = await waitActive(r.ToolId);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        region: REGION,
        created,
        tool: {
          toolId: tool.ToolId,
          toolName: tool.ToolName,
          toolType: tool.ToolType,
          status: tool.Status,
          persistent: tool.Persistent,
          defaultTimeoutSeconds: tool.DefaultTimeoutSeconds,
          network: tool.NetworkConfiguration,
          custom: tool.CustomConfiguration,
        },
      },
      null,
      2
    )
  );
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: errInfo(e) }));
  process.exit(1);
});