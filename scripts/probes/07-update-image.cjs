/**
 * 探针 07：把 custom 工具镜像改为腾讯云 CCR 公共库镜像，验证拉取
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const TOOL_ID = process.env.TC_TOOL_ID || "sdt-lfg351za";
const IMAGE = process.env.TC_IMAGE || "ccr.ccs.tencentyun.com/library/python:3.12-slim";

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
  try {
    await client.UpdateSandboxTool({
      ToolId: TOOL_ID,
      CustomConfiguration: {
        Image: IMAGE,
        ImageRegistryType: process.env.TC_IMAGE_REGISTRY_TYPE || "custom",
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
  } catch (e) {
    console.error(JSON.stringify({ ok: false, stage: "update", error: errInfo(e) }));
    process.exit(1);
  }

  const start = Date.now();
  let tool;
  while (Date.now() - start < 240000) {
    const q = await client.DescribeSandboxToolList({ ToolIds: [TOOL_ID], Limit: 5 });
    tool = (q.SandboxToolSet || [])[0];
    if (tool && ["ACTIVE", "FAILED"].includes(tool.Status)) break;
    await sleep(3000);
  }

  console.log(
    JSON.stringify(
      {
        ok: tool?.Status === "ACTIVE",
        image: IMAGE,
        status: tool?.Status,
        statusReason: tool?.StatusReason,
        elapsedMs: Date.now() - start,
        custom: tool?.CustomConfiguration,
      },
      null,
      2
    )
  );
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: errInfo(e) }));
  process.exit(1);
});