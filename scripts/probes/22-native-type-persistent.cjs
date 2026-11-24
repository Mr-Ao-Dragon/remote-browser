/**
 * 探针 22：尝试平台原生 ToolType（aio / osworld / code-interpreter）是否支持 Persistent
 * 若支持，就能跳过自定义镜像，直接拿到带浏览器的常驻沙箱。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const TYPE = process.env.TC_TOOL_TYPE || "aio";

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
const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: String(e?.message || e).slice(0, 260) });

(async () => {
  const name = `rb-type-${TYPE}-${Math.random().toString(36).slice(2, 5)}`;
  const out = { type: TYPE, toolName: name };
  let toolId;
  try {
    const r = await client.CreateSandboxTool({
      ToolName: name,
      ToolType: TYPE,
      NetworkConfiguration: { NetworkMode: "PUBLIC" },
      Persistent: true,
      DefaultTimeout: "30m",
      Description: `persistent ${TYPE} probe`,
    });
    toolId = r.ToolId;
    out.toolId = toolId;
  } catch (e) {
    out.createError = errInfo(e);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const t0 = Date.now();
  let cur = {};
  while (Date.now() - t0 < 180000) {
    const q = await client.DescribeSandboxToolList({ ToolIds: [toolId], Limit: 1 });
    cur = (q.SandboxToolSet || [])[0] || cur;
    if (["ACTIVE", "FAILED"].includes(cur.Status)) break;
    await sleep(3000);
  }
  out.status = cur.Status;
  out.statusReason = cur.StatusReason;
  out.elapsedMs = Date.now() - t0;
  if (cur.CustomConfiguration) {
    out.custom = {
      image: cur.CustomConfiguration.Image,
      registryType: cur.CustomConfiguration.ImageRegistryType,
      ports: cur.CustomConfiguration.Ports,
    };
  }
  out.toolIdKeep = toolId;
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});