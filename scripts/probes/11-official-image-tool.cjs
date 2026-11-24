/**
 * 探针 11：用 AGS 官方镜像创建持久 custom 工具
 *
 * 关键假设：ImageRegistryType 支持 "system"，表示平台自有镜像仓库，
 * 可能不需要 RoleArn（文档 CLI 页提到 enterprise / personal / system）。
 *
 * 环境变量：
 *  TC_IMAGE                 镜像地址
 *  TC_IMAGE_REGISTRY_TYPE   system | personal | enterprise | (空=自动识别)
 *  TC_TOOL_NAME             工具名
 *  TC_PORTS                 形如 9000 或 9000,49999
 *  TC_PROBE_PATH            健康检查路径，默认 /
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const TOOL_NAME = process.env.TC_TOOL_NAME || "rb-probe-sysimg";
const IMAGE = process.env.TC_IMAGE || "ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest";
const REGISTRY_TYPE = process.env.TC_IMAGE_REGISTRY_TYPE || "system";
const PORTS = (process.env.TC_PORTS || "9000").split(",").map((p) => Number(p.trim()));
const PROBE_PATH = process.env.TC_PROBE_PATH || "/";

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
const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: e?.message || String(e), requestId: e?.requestId });

(async () => {
  const exist = await client.DescribeSandboxToolList({ Limit: 100 });
  let tool = (exist.SandboxToolSet || []).find((t) => t.ToolName === TOOL_NAME);

  if (!tool) {
    const body = {
      ToolName: TOOL_NAME,
      ToolType: "custom",
      NetworkConfiguration: { NetworkMode: "PUBLIC" },
      Persistent: true,
      DefaultTimeout: "10m",
      Description: "remote-browser official image probe",
      CustomConfiguration: {
        Image: IMAGE,
        Command: ["/init"],
        Args: ["sleep", "infinity"],
        Ports: PORTS.map((p) => ({ Name: `p${p}`, Port: p, Protocol: "TCP" })),
        Resources: { CPU: "2", Memory: "1Gi" },
        Probe: {
          HttpGet: { Path: PROBE_PATH, Port: PORTS[0], Scheme: "HTTP" },
          ReadyTimeoutMs: 30000,
          ProbeTimeoutMs: 3000,
          ProbePeriodMs: 2000,
          SuccessThreshold: 1,
          FailureThreshold: 30,
        },
      },
    };
    if (REGISTRY_TYPE) body.CustomConfiguration.ImageRegistryType = REGISTRY_TYPE;
    if (process.env.TC_ROLE_ARN) body.RoleArn = process.env.TC_ROLE_ARN;

    try {
      const r = await client.CreateSandboxTool(body);
      console.log(JSON.stringify({ stage: "created", toolId: r.ToolId, image: IMAGE, registryType: REGISTRY_TYPE }, null, 2));
      tool = { ToolId: r.ToolId, Status: "CREATING" };
    } catch (e) {
      console.error(JSON.stringify({ ok: false, stage: "create", image: IMAGE, registryType: REGISTRY_TYPE, error: errInfo(e) }, null, 2));
      return;
    }
  } else {
    console.log(JSON.stringify({ stage: "exists", toolId: tool.ToolId, status: tool.Status }, null, 2));
  }

  const start = Date.now();
  let cur = tool;
  while (Date.now() - start < 240000) {
    const q = await client.DescribeSandboxToolList({ ToolIds: [tool.ToolId], Limit: 5 });
    cur = (q.SandboxToolSet || [])[0] || cur;
    if (["ACTIVE", "FAILED"].includes(cur.Status)) break;
    await sleep(3000);
  }

  console.log(
    JSON.stringify(
      {
        ok: cur.Status === "ACTIVE",
        toolId: cur.ToolId,
        image: IMAGE,
        registryType: REGISTRY_TYPE,
        status: cur.Status,
        statusReason: cur.StatusReason,
        elapsedMs: Date.now() - start,
      },
      null,
      2
    )
  );
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, fatal: errInfo(e) }, null, 2));
  process.exit(1);
});