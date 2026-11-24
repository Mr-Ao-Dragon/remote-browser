/**
 * 探针 26：按亲和模式创建部署并验证数据面（P1/P3）
 * 用法：TC_AFFINITY_MODE=BEST_EFFORT TC_DEPLOYMENT_NAME=rb-probe-best
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DATA_PLANE_DOMAIN || "tencentags.com";
const TOOL_ID = process.env.TC_TOOL_ID || "sdt-gdf08rfu";
const MODE = process.env.TC_AFFINITY_MODE || "BEST_EFFORT";
const NAME = process.env.TC_DEPLOYMENT_NAME || `rb-probe-${MODE.toLowerCase().replace(/_/g, "-")}`;
const HEADER = process.env.TC_AFFINITY_HEADER || "X-Rb-Affinity";
const PORT = 9000;
const IDLE = Number(process.env.TC_IDLE_SECONDS || 60);

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

async function waitDeployment(id, ms) {
  const t0 = Date.now();
  let d = {};
  while (Date.now() - t0 < ms) {
    const r = await client.DescribeDeployment({ DeploymentId: id });
    d = r.Deployment || {};
    if (["ACTIVE", "DELETE_FAILED"].includes(d.Status)) break;
    await sleep(3000);
  }
  return d;
}

async function get(url, token, affinity) {
  const t0 = Date.now();
  const headers = { "X-Access-Token": token };
  if (affinity) headers[HEADER] = affinity;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(180000) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      status: res.status,
      ms: Date.now() - t0,
      browser: json && json.Browser,
      wsTail: json && json.webSocketDebuggerUrl ? (json.webSocketDebuggerUrl.split("/").pop() || "").slice(0, 12) : undefined,
      head: text.slice(0, 160),
    };
  } catch (e) {
    return { error: String(e?.message || e), ms: Date.now() - t0 };
  }
}

(async () => {
  const out = { mode: MODE, name: NAME };
  const list = await client.DescribeDeploymentList({ Limit: 100 });
  let dpl = (list.DeploymentSet || []).find((d) => d.DeploymentName === NAME);
  if (!dpl) {
    const body = {
      DeploymentName: NAME,
      ToolId: TOOL_ID,
      ScalingConfiguration: { MinInstanceCount: 0, MaxInstanceCount: 3, MaxInstanceRequestConcurrency: 1 },
      LifecycleConfiguration: { IdleTimeoutSeconds: IDLE, IdleAction: "STOP" },
      AffinityConfiguration: { Mode: MODE, HeaderName: HEADER },
    };
    try {
      const r = await client.CreateDeployment(body);
      dpl = r.Deployment;
      out.created = true;
    } catch (e) {
      out.createError = errInfo(e);
      console.log(JSON.stringify(out, null, 2));
      return;
    }
  } else out.reused = true;

  const d = await waitDeployment(dpl.DeploymentId, 120000);
  out.deploymentId = dpl.DeploymentId;
  out.status = d.Status;
  out.affinity = d.AffinityConfiguration;

  const tk = await client.AcquireDeploymentToken({ DeploymentId: dpl.DeploymentId });
  const url = `https://${PORT}-${dpl.DeploymentId}.${REGION}.agents.${DOMAIN}/cdp/json/version`;

  out.firstWithAffinity = await get(url, tk.Token, "sess-a");
  out.instances1 = ((await client.DescribeSandboxInstanceList({ Limit: 50 })).InstanceSet || []).map((i) => ({
    id: i.InstanceId.slice(0, 8),
    tool: i.ToolId,
    status: i.Status,
  }));

  out.secondWithSameAffinity = await get(url, tk.Token, "sess-a");

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});