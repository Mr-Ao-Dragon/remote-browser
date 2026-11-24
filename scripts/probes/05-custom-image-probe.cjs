/**
 * 探针 05：试探 custom 工具能否引用公共镜像
 * 只创建工具，不启动实例。失败会直接返回平台校验错误。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const TOOL_NAME = process.env.TC_TOOL_NAME || "rb-probe-custom";
const IMAGE = process.env.TC_IMAGE || "node:20-alpine";
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

const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: e?.message || String(e) });

(async () => {
  const exist = await client.DescribeSandboxToolList({ Limit: 100 });
  const found = (exist.SandboxToolSet || []).find((t) => t.ToolName === TOOL_NAME);
  if (found) {
    console.log(JSON.stringify({ ok: true, reused: true, tool: found }, null, 2));
    return;
  }

  try {
    const r = await client.CreateSandboxTool({
      ToolName: TOOL_NAME,
      ToolType: "custom",
      NetworkConfiguration: { NetworkMode: "PUBLIC" },
      Persistent: true,
      DefaultTimeout: "10m",
      Description: "remote-browser custom probe",
      ClientToken: `rb-probe-custom-${REGION}`,
      CustomConfiguration: {
        Image: IMAGE,
        ImageRegistryType: REGISTRY_TYPE,
        Command: ["node"],
        Args: ["-e", "require('http').createServer((q,s)=>s.end('ok')).listen(9000)"],
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
    console.log(JSON.stringify({ ok: true, created: true, image: IMAGE, registryType: REGISTRY_TYPE, resp: r }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, image: IMAGE, registryType: REGISTRY_TYPE, error: errInfo(e) }, null, 2));
  }
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: errInfo(e) }));
  process.exit(1);
});