/**
 * 探针 08：用腾讯云 CCR 公共镜像创建新的 custom 工具
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const TOOL_NAME = process.env.TC_TOOL_NAME || "rb-probe-ccr";
const IMAGE = process.env.TC_IMAGE || "ccr.ccs.tencentyun.com/library/python:3.12-slim";
const REGISTRY_TYPE = process.env.TC_IMAGE_REGISTRY_TYPE || "custom";

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

const Client = tc.ags.v20250920.Client;
const client = new Client({
  credential: loadCreds(),
  region: REGION,
  profile: { httpProfile: { endpoint: "ags.tencentcloudapi.com", reqTimeout: 30 } },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: e?.message || String(e) });

(async () => {
  const exist = await client.DescribeSandboxToolList({ Limit: 100 });
  let tool = (exist.SandboxToolSet || []).find((t) => t.ToolName === TOOL_NAME);

  if (!tool) {
    try {
      const r = await client.CreateSandboxTool({
        ToolName: TOOL_NAME,
        ToolType: "custom",
        NetworkConfiguration: { NetworkMode: "PUBLIC" },
        Persistent: true,
        DefaultTimeout: "10m",
        Description: "remote-browser ccr probe",
        ClientToken: `rb-probe-ccr-${REGION}`,
        CustomConfiguration: {
          Image: IMAGE,
          ImageRegistryType: REGISTRY_TYPE,
          Command: ["python"],
          Args: ["-m", "http.server", "9000"],
          Ports: [{ Name: "http", Port: 9000, Protocol: "TCP" }],
          Resources: { CPU: "1", Memory: "1Gi" },
          Probe: {
            HttpGet: { Path: "/", Port: 9000, Scheme: "HTTP" },
            ReadyTimeoutMs: 30000,
            ProbeTimeoutMs: 3000,
            ProbePeriodMs: 2000,
            SuccessThreshold: 1,
            FailureThreshold: 30,
          },
        },
      });
      console.log(JSON.stringify({ stage: "created", toolId: r.ToolId, image: IMAGE }, null, 2));
      tool = { ToolId: r.ToolId, Status: "CREATING" };
    } catch (e) {
      console.error(JSON.stringify({ ok: false, stage: "create", image: IMAGE, error: errInfo(e) }));
      process.exit(1);
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
  console.error(JSON.stringify({ ok: false, error: errInfo(e) }));
  process.exit(1);
});