/**
 * 探针 17：把已 ACTIVE 的 custom 工具改成浏览器端口（9000），准备绑定 Deployment
 *
 * 复用 sdt-7xbs3878（sandbox-browser 镜像），先尝试 UpdateSandboxTool 改 Ports/Probe；
 * 若不允许改，则新建 rb-browser-persist。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const TARGET = process.env.TC_TOOL_ID || "sdt-7xbs3878";
const IMAGE = "ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest";
const NEW_NAME = "rb-browser-persist";

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

const client = new tc.ags.v20250920.Client({
  credential: loadCreds(),
  region: REGION,
  profile: { httpProfile: { endpoint: "ags.tencentcloudapi.com", reqTimeout: 30 } },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: String(e?.message || e).slice(0, 240) });

const PORTS = [
  { Name: "cdp", Port: 9000, Protocol: "TCP" },
  { Name: "envd", Port: 49983, Protocol: "TCP" },
];
const PROBE = {
  HttpGet: { Path: "/", Port: 9000, Scheme: "HTTP" },
  ReadyTimeoutMs: 30000,
  ProbeTimeoutMs: 3000,
  ProbePeriodMs: 2000,
  SuccessThreshold: 1,
  FailureThreshold: 10,
};

async function waitTool(toolId, ms) {
  const start = Date.now();
  let last = {};
  while (Date.now() - start < ms) {
    const q = await client.DescribeSandboxToolList({ ToolIds: [toolId], Limit: 1 });
    last = (q.SandboxToolSet || [])[0] || last;
    if (["ACTIVE", "FAILED"].includes(last.Status)) break;
    await sleep(2500);
  }
  return last;
}

(async () => {
  const out = {};

  // 1) 尝试改已有工具（端口疑似不可变，默认跳过）
  if (process.env.TC_SKIP_UPDATE === "1") {
    out.update = { ok: false, skipped: true };
  } else
  try {
    await client.UpdateSandboxTool({
      ToolId: TARGET,
      CustomConfiguration: {
        Image: IMAGE,
        ImageRegistryType: "custom",
        Command: ["/init"],
        Args: ["sleep", "infinity"],
        Ports: PORTS,
        Resources: { CPU: "2", Memory: "4Gi" },
        Probe: PROBE,
      },
    });
    out.update = { ok: true };
    const t = await waitTool(TARGET, 120000);
    out.updatedTool = { toolId: TARGET, status: t.Status, statusReason: t.StatusReason, ports: t.CustomConfiguration?.Ports };
  } catch (e) {
    out.update = { ok: false, error: errInfo(e) };
  }

  if (out.updatedTool && out.updatedTool.status === "ACTIVE") {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // 2) 兜底：新建
  const exist = await client.DescribeSandboxToolList({ Limit: 100 });
  let tool = (exist.SandboxToolSet || []).find((t) => t.ToolName === NEW_NAME);
  if (!tool) {
    const r = await client.CreateSandboxTool({
      ToolName: NEW_NAME,
      ToolType: "custom",
      NetworkConfiguration: { NetworkMode: "PUBLIC" },
      Persistent: true,
      DefaultTimeout: "30m",
      Description: "persistent browser sandbox (official image, CDP on 9000)",
      CustomConfiguration: {
        Image: IMAGE,
        ImageRegistryType: "custom",
        Command: ["/init"],
        Args: ["sleep", "infinity"],
        Ports: PORTS,
        Resources: { CPU: "2", Memory: "4Gi" },
        Probe: PROBE,
      },
    });
    out.created = { toolId: r.ToolId };
    tool = { ToolId: r.ToolId };
  } else {
    out.created = { toolId: tool.ToolId, reused: true };
  }
  const t = await waitTool(tool.ToolId, 180000);
  out.newTool = { toolId: tool.ToolId, status: t.Status, statusReason: t.StatusReason, ports: t.CustomConfiguration?.Ports };

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});