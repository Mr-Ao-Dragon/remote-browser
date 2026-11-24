/**
 * 探针 27：查实例归属与直连数据面，定位部署 502 的根因
 * 用法：node scripts/probes/27-instance-diag.js [deploymentId]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DATA_PLANE_DOMAIN || "tencentags.com";
const DPL = process.argv[2] || process.env.TC_DEPLOYMENT_ID || "dpl-kgw27cnt";

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

const redact = (s) => String(s || "").replace(/[A-Za-z0-9_-]{20,}/g, (m) => m.slice(0, 4) + "***");

async function get(url, headers = {}, ms = 20000) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      status: res.status,
      ms: Date.now() - t0,
      contentType: res.headers.get("content-type"),
      browser: json && json.Browser,
      head: text.slice(0, 140).replace(/\s+/g, " "),
    };
  } catch (e) {
    return { error: redact(e?.message || e), ms: Date.now() - t0 };
  }
}

(async () => {
  const out = {};
  const list = await client.DescribeSandboxInstanceList({ Limit: 50 });
  out.instances = (list.InstanceSet || []).map((i) => ({
    id: i.InstanceId,
    tool: i.ToolId,
    status: i.Status,
    deploymentId: i.DeploymentId,
    created: i.CreatedAt,
    updated: i.UpdatedAt,
    endpoint: i.Endpoint ? redact(i.Endpoint) : undefined,
    keys: Object.keys(i),
  }));

  out.deployment = (await client.DescribeDeployment({ DeploymentId: DPL }).catch((e) => ({ error: redact(e.message) })))
    .Deployment;

  // 该部署下的实例直连
  const mine = (list.InstanceSet || []).filter((i) => i.DeploymentId === DPL && i.Status === "RUNNING");
  out.direct = [];
  for (const i of mine) {
    const base = `https://9000-${i.InstanceId}.${REGION}.${DOMAIN}`;
    out.direct.push({
      id: i.InstanceId,
      root: await get(base + "/", {}, 15000),
      cdp: await get(base + "/cdp/json/version", {}, 15000),
    });
  }

  // 部署入口 / 根路径
  const tk = await client.AcquireDeploymentToken({ DeploymentId: DPL });
  const dBase = `https://9000-${DPL}.${REGION}.agents.${DOMAIN}`;
  out.deploymentProbe = {
    root: await get(dBase + "/", { "X-Access-Token": tk.Token, "X-Rb-Affinity": "sess-a" }, 60000),
    cdp: await get(dBase + "/cdp/json/version", { "X-Access-Token": tk.Token, "X-Rb-Affinity": "sess-a" }, 60000),
  };

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: redact(e?.message || e) }, null, 2));
  process.exit(1);
});