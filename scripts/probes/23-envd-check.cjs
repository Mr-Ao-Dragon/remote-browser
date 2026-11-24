/**
 * 探针 23：检查 sandbox-browser 镜像实例的 envd（49983）能力
 * 若 envd 可用，就能在沙箱内执行命令，进而确认镜像内是否自带 Chromium。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DOMAIN || "tencentags.com";
const TOOL_ID = process.env.TC_TOOL_ID || "sdt-r8cmnbka";

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
  profile: { httpProfile: { endpoint: "ags.tencentcloudapi.com", reqTimeout: 40 } },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: String(e?.message || e).slice(0, 260) });

async function listInstances() {
  const r = await client.DescribeSandboxInstanceList({ Limit: 50 });
  return (r.InstanceSet || []).map((i) => ({
    instanceId: i.InstanceId,
    toolId: i.ToolId,
    status: i.Status,
    expiresAt: i.ExpiresAt,
  }));
}

async function req(url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    return { status: res.status, ms: Date.now() - t0, head: text.slice(0, 400) };
  } catch (e) {
    return { error: String(e?.message || e), ms: Date.now() - t0 };
  }
}

(async () => {
  const out = {};
  out.instancesBefore = await listInstances();

  const inst = await client.StartSandboxInstance({ ToolId: TOOL_ID, Timeout: "10m", AuthMode: "PUBLIC" });
  const instanceId = inst.Instance && inst.Instance.InstanceId;
  out.instanceId = instanceId;

  let s = {};
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const q = await client.DescribeSandboxInstanceList({ InstanceIds: [instanceId], Limit: 1 });
    s = (q.InstanceSet || [])[0] || s;
    if (["RUNNING", "FAILED", "STOPPED"].includes(s.Status)) break;
    await sleep(2000);
  }
  out.status = s.Status;
  out.startMs = Date.now() - t0;

  const tk = await client.AcquireSandboxInstanceToken({ InstanceId: instanceId });
  const h = { "X-Access-Token": tk.Token };
  const envd = `https://49983-${instanceId}.${REGION}.${DOMAIN}`;
  const web = `https://9000-${instanceId}.${REGION}.${DOMAIN}`;

  out.envdHealth = await req(`${envd}/health`, { headers: h });
  out.envdRoot = await req(`${envd}/`, { headers: h });
  out.envdEnvs = await req(`${envd}/envs`, { headers: h });
  out.webRoot = await req(`${web}/`, { headers: h });
  out.webCdp = await req(`${web}/cdp/json/version`, { headers: h });

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});