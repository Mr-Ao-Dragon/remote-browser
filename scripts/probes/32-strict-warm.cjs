/**
 * 探针 32：STRICT 亲和 + MinInstanceCount=1（预热池）能否绑定并复用
 * 用法：node scripts/probes/32-strict-warm.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DATA_PLANE_DOMAIN || "tencentags.com";
const TOOL_ID = process.env.TC_TOOL_ID || "sdt-gdf08rfu";
const NAME = process.env.TC_DEPLOYMENT_NAME || "rb-probe-strict-warm";
const HEADER = "X-Rb-Affinity";
const MODE = process.env.TC_AFFINITY_MODE || "STRICT";
const MIN = Number(process.env.TC_MIN || 1);

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

async function hit(base, token, sess, tries = 10) {
  for (let i = 1; i <= tries; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${base}/cdp/json/version`, {
        headers: { "X-Access-Token": token, [HEADER]: sess },
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      if (res.ok) {
        const j = JSON.parse(text);
        const m = /^wss?:\/\/(\d+)-([a-z0-9]+)\./.exec(j.webSocketDebuggerUrl || "");
        return { ok: true, status: res.status, ms: Date.now() - t0, instance: m ? m[2].slice(0, 8) : "?" };
      }
      if (i === 1) var first = { status: res.status, body: text.slice(0, 100), ms: Date.now() - t0 };
    } catch (e) {
      var first = { error: String(e?.message || e).slice(0, 80) };
    }
    await sleep(3000);
  }
  return { ok: false, first };
}

(async () => {
  const out = { name: NAME, min: MIN, mode: MODE };
  const list = await client.DescribeDeploymentList({ Limit: 100 });
  let dpl = (list.DeploymentSet || []).find((d) => d.DeploymentName === NAME);
  if (!dpl) {
    try {
      dpl = (
        await client.CreateDeployment({
          DeploymentName: NAME,
          ToolId: TOOL_ID,
          ScalingConfiguration: { MinInstanceCount: MIN, MaxInstanceCount: 5, MaxInstanceRequestConcurrency: 1 },
          LifecycleConfiguration: { IdleTimeoutSeconds: 120, IdleAction: "STOP" },
          AffinityConfiguration: { Mode: MODE, HeaderName: HEADER },
        })
      ).Deployment;
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
  out.instancesBefore = ((await client.DescribeSandboxInstanceList({ Limit: 50 })).InstanceSet || [])
    .filter((i) => i.ToolId === TOOL_ID)
    .map((i) => ({ id: i.InstanceId.slice(0, 8), status: i.Status }));

  const tk = await client.AcquireDeploymentToken({ DeploymentId: dpl.DeploymentId });
  const base = `https://9000-${dpl.DeploymentId}.${REGION}.agents.${DOMAIN}`;

  out.a1 = await hit(base, tk.Token, "sess-a");
  out.a2 = await hit(base, tk.Token, "sess-a");
  out.b1 = await hit(base, tk.Token, "sess-b");
  out.a3 = await hit(base, tk.Token, "sess-a");
  out.instancesAfter = ((await client.DescribeSandboxInstanceList({ Limit: 50 })).InstanceSet || [])
    .filter((i) => i.ToolId === TOOL_ID)
    .map((i) => ({ id: i.InstanceId.slice(0, 8), status: i.Status }));

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});