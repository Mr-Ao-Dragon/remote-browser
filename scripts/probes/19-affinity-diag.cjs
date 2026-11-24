/**
 * 探针 19：亲和模式诊断
 *  - 查看实例状态
 *  - 用全新 Affinity ID 重试（EXCLUSIVE 是否要求先有可用实例）
 *  - 重复同一 ID，看是否复用同一实例
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DATA_PLANE_DOMAIN || "tencentags.com";
const DEPLOYMENT_ID = process.env.TC_DEPLOYMENT_ID || "dpl-12626urb";
const PORT = Number(process.env.TC_PORT || 9000);
const HEADER = process.env.TC_AFFINITY_HEADER || "X-Rb-Affinity";

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
  return (r.SandboxInstanceSet || []).map((i) => ({
    instanceId: i.InstanceId,
    toolId: i.ToolId,
    status: i.Status,
    authMode: i.AuthMode,
    createdAt: i.CreatedAt,
    expiresAt: i.ExpiresAt,
  }));
}

async function probe(affinityId, timeoutMs = 60000) {
  const url = `https://${PORT}-${DEPLOYMENT_ID}.${REGION}.agents.${DOMAIN}/cdp/json/version`;
  const t0 = Date.now();
  const headers = { "X-Access-Token": global.__tok };
  if (affinityId) headers[HEADER] = affinityId;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      affinityId,
      status: res.status,
      ms: Date.now() - t0,
      uuid: json && json.webSocketDebuggerUrl ? (json.webSocketDebuggerUrl.split("/").pop() || "").slice(0, 12) : undefined,
      browser: json && json.Browser,
      bodyHead: text.slice(0, 200),
    };
  } catch (e) {
    return { affinityId, error: String(e && e.message ? e.message : e), ms: Date.now() - t0 };
  }
}

(async () => {
  const out = {};
  out.instancesBefore = await listInstances();

  const tk = await client.AcquireDeploymentToken({ DeploymentId: DEPLOYMENT_ID });
  global.__tok = tk.Token;
  out.tokenExpiresAt = tk.ExpiresAt;

  const fresh = `probe-${Date.now().toString(36)}`;
  out.attempt1 = await probe(fresh, 120000);
  out.instancesAfter1 = await listInstances();

  await sleep(5000);
  out.attempt2_sameId = await probe(fresh, 120000);
  out.instancesAfter2 = await listInstances();

  out.attempt3_noHeader = await probe(null, 60000);

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});