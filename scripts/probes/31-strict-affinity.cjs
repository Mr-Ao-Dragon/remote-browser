/**
 * 探针 31：STRICT 亲和 —— 同 header 复用同一实例，不同 header 分离
 * 用法：node scripts/probes/31-strict-affinity.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DATA_PLANE_DOMAIN || "tencentags.com";
const TOOL_ID = process.env.TC_TOOL_ID || "sdt-gdf08rfu";
const NAME = process.env.TC_DEPLOYMENT_NAME || "rb-probe-strict";
const HEADER = "X-Rb-Affinity";
const PORT = 9000;
const IDLE = 60;

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
const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: String(e?.message || e).slice(0, 240) });

// 从 version 响应推断命中的实例（ws host 前缀）
async function hit(base, token, sess, tries = 25) {
  const trace = [];
  for (let i = 1; i <= tries; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${base}/cdp/json/version`, {
        headers: { "X-Access-Token": token, [HEADER]: sess },
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      trace.push({ i, status: res.status, ms: Date.now() - t0 });
      if (res.ok) {
        const j = JSON.parse(text);
        const m = /^wss?:\/\/(\d+)-([a-z0-9]+)\./.exec(j.webSocketDebuggerUrl || "");
        return { ok: true, status: res.status, instancePrefix: m ? m[2].slice(0, 8) : "?", trace };
      }
      if (![409, 502, 503, 504].includes(res.status)) return { ok: false, status: res.status, body: text.slice(0, 120), trace };
    } catch (e) {
      trace.push({ i, error: String(e?.message || e).slice(0, 60), ms: Date.now() - t0 });
    }
    await sleep(3000);
  }
  return { ok: false, trace };
}

(async () => {
  const out = { name: NAME };
  const list = await client.DescribeDeploymentList({ Limit: 100 });
  let dpl = (list.DeploymentSet || []).find((d) => d.DeploymentName === NAME);
  if (!dpl) {
    try {
      const r = await client.CreateDeployment({
        DeploymentName: NAME,
        ToolId: TOOL_ID,
        ScalingConfiguration: { MinInstanceCount: 0, MaxInstanceCount: 5, MaxInstanceRequestConcurrency: 1 },
        LifecycleConfiguration: { IdleTimeoutSeconds: IDLE, IdleAction: "STOP" },
        AffinityConfiguration: { Mode: "STRICT", HeaderName: HEADER },
      });
      dpl = r.Deployment;
      out.created = true;
    } catch (e) {
      out.createError = errInfo(e);
      console.log(JSON.stringify(out, null, 2));
      return;
    }
  }
  let d = {};
  for (let i = 0; i < 40; i++) {
    d = (await client.DescribeDeployment({ DeploymentId: dpl.DeploymentId })).Deployment || {};
    if (d.Status === "ACTIVE") break;
    await sleep(3000);
  }
  out.deploymentId = dpl.DeploymentId;
  out.status = d.Status;

  const tk = await client.AcquireDeploymentToken({ DeploymentId: dpl.DeploymentId });
  const base = `https://${PORT}-${dpl.DeploymentId}.${REGION}.agents.${DOMAIN}`;

  out.a1 = await hit(base, tk.Token, "sess-a");
  out.a2 = await hit(base, tk.Token, "sess-a");
  out.b1 = await hit(base, tk.Token, "sess-b");
  out.a3 = await hit(base, tk.Token, "sess-a");

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});