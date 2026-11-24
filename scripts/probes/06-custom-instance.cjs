/**
 * 探针 06：启动 custom 工具实例，验证镜像拉取、启动命令、探针
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DOMAIN || "tencentags.com";
const TOOL_ID = process.env.TC_TOOL_ID || "sdt-lfg351za";

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

async function waitToolActive(timeoutMs = 180000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    const q = await client.DescribeSandboxToolList({ ToolIds: [TOOL_ID], Limit: 5 });
    const t = (q.SandboxToolSet || [])[0];
    if (t) {
      last = t;
      if (t.Status === "ACTIVE") return t;
      if (t.Status === "FAILED") throw new Error(`tool FAILED: ${t.Status}`);
    }
    await sleep(3000);
  }
  throw new Error(`tool not active: ${JSON.stringify(last)}`);
}

(async () => {
  await waitToolActive();
  const r = await client.StartSandboxInstance({
    ToolId: TOOL_ID,
    Timeout: "5m",
    AuthMode: "PUBLIC",
    ClientToken: `rb-probe-custom-inst-${Date.now()}`,
  });
  const instanceId = r.Instance.InstanceId;

  const start = Date.now();
  let inst = r.Instance;
  while (Date.now() - start < 180000) {
    const q = await client.DescribeSandboxInstanceList({ InstanceIds: [instanceId], Limit: 5 });
    inst = (q.InstanceSet || [])[0] || inst;
    if (["RUNNING", "FAILED", "STOP_FAILED", "STOPPED"].includes(inst.Status)) break;
    await sleep(3000);
  }

  const out = {
    ok: inst.Status === "RUNNING",
    instanceId,
    status: inst.Status,
    stopReason: inst.StopReason,
    elapsedMs: Date.now() - start,
    image: inst.CustomConfiguration?.Image,
    ports: inst.CustomConfiguration?.Ports,
  };

  if (inst.Status === "RUNNING") {
    try {
      const res = await fetch(`https://9000-${instanceId}.${REGION}.${DOMAIN}/`, {
        signal: AbortSignal.timeout(10000),
      });
      out.http = { status: res.status, body: (await res.text()).slice(0, 100) };
    } catch (e) {
      out.httpError = `${e.name}: ${e.message}`;
    }
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: errInfo(e) }));
  process.exit(1);
});