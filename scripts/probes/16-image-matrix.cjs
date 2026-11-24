/**
 * 探针 16：镜像来源组合测试（失败自动清理，避免占配额）
 *
 * 用法：
 *   node scripts/probes/16-image-matrix.js
 * 或指定组合：
 *   TC_CASES='[{"name":"...","image":"...","registryType":"custom"}]'
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

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

const client = new tc.ags.v20250920.Client({
  credential: loadCreds(),
  region: REGION,
  profile: { httpProfile: { endpoint: "ags.tencentcloudapi.com", reqTimeout: 30 } },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: String(e?.message || e).slice(0, 200) });

const DEFAULT_CASES = [
  {
    name: "custom-mirror-ccr",
    image: "mirror.ccs.tencentyun.com/library/python:3.12-slim",
    registryType: "custom",
  },
  {
    name: "custom-ags-image",
    image: "ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest",
    registryType: "custom",
  },
];

async function runCase(c, idx) {
  const toolName = `rb-mx-${idx}-${Math.random().toString(36).slice(2, 6)}`;
  const result = { name: c.name, image: c.image, registryType: c.registryType };

  let toolId;
  try {
    const r = await client.CreateSandboxTool({
      ToolName: toolName,
      ToolType: "custom",
      NetworkConfiguration: { NetworkMode: "PUBLIC" },
      Persistent: true,
      DefaultTimeout: "10m",
      Description: "image matrix probe",
      CustomConfiguration: {
        Image: c.image,
        ImageRegistryType: c.registryType,
        Command: ["/init"],
        Args: ["sleep", "infinity"],
        Ports: [{ Name: "p8000", Port: 8000, Protocol: "TCP" }],
        Resources: { CPU: "1", Memory: "1Gi" },
        Probe: {
          HttpGet: { Path: "/", Port: 8000, Scheme: "HTTP" },
          ReadyTimeoutMs: 30000,
          ProbeTimeoutMs: 3000,
          ProbePeriodMs: 2000,
          SuccessThreshold: 1,
          FailureThreshold: 5,
        },
      },
    });
    toolId = r.ToolId;
    result.toolId = toolId;
  } catch (e) {
    result.createError = errInfo(e);
    return result;
  }

  const start = Date.now();
  let status = "CREATING";
  let statusReason;
  while (Date.now() - start < 90000) {
    const q = await client.DescribeSandboxToolList({ ToolIds: [toolId], Limit: 1 });
    const t = (q.SandboxToolSet || [])[0];
    if (t) {
      status = t.Status;
      statusReason = t.StatusReason;
    }
    if (["ACTIVE", "FAILED"].includes(status)) break;
    await sleep(2500);
  }
  result.status = status;
  result.statusReason = String(statusReason || "").slice(0, 200);
  result.elapsedMs = Date.now() - start;

  if (status === "FAILED") {
    try {
      await client.DeleteSandboxTool({ ToolId: toolId });
      result.cleanedUp = true;
    } catch (e) {
      result.cleanupError = errInfo(e);
    }
  }
  return result;
}

(async () => {
  const cases = process.env.TC_CASES ? JSON.parse(process.env.TC_CASES) : DEFAULT_CASES;
  const out = [];
  for (let i = 0; i < cases.length; i++) {
    out.push(await runCase(cases[i], i));
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});