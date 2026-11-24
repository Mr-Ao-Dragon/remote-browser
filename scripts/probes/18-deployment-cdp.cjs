/**
 * 探针 18：P1/P2 —— 弹性部署入口 + dpt Token + CDP 探测
 *
 * 步骤：
 *  1. 创建 Deployment（绑定 rb-browser-persist / sdt-oo1phxia）
 *  2. 等 ACTIVE
 *  3. AcquireDeploymentToken
 *  4. GET https://9000-{dpl}.{region}.agents.tencentags.com/cdp/json/version
 *     Header: X-Access-Token: dpt_***, X-Affinity
 *  5. 报告状态码、耗时、webSocketDebuggerUrl 结构（脱敏，只打印 host 形式与 uuid 是否一致）
 *
 * 不打印任何 Token 明文。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DATA_PLANE_DOMAIN || "tencentags.com";
const TOOL_ID = process.env.TC_TOOL_ID || "sdt-oo1phxia";
const PORT = Number(process.env.TC_PORT || 9000);
const IDLE = Number(process.env.TC_IDLE_SECONDS || 60);
const AFFINITY_MODE = process.env.TC_AFFINITY_MODE || "EXCLUSIVE";
const AFFINITY_HEADER = process.env.TC_AFFINITY_HEADER || "X-Rb-Affinity";

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
const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: String(e?.message || e).slice(0, 300) });

function maskWsUrl(u) {
  try {
    const x = new URL(u);
    return {
      protocol: x.protocol,
      host: x.hostname,
      hostPort: x.port,
      pathPrefix: x.pathname.split("/").slice(0, 3).join("/"),
      uuidTail: (x.pathname.split("/").pop() || "").slice(0, 12),
    };
  } catch {
    return { raw: String(u).slice(0, 40) };
  }
}

async function getDeployment(deploymentId) {
  const r = await client.DescribeDeployment({ DeploymentId: deploymentId });
  return r.Deployment;
}

async function waitDeployment(deploymentId, ms) {
  const start = Date.now();
  let d = {};
  while (Date.now() - start < ms) {
    d = await getDeployment(deploymentId);
    if (d && ["ACTIVE", "DELETE_FAILED"].includes(d.Status)) break;
    await sleep(3000);
  }
  return d;
}

async function httpGet(url, token, affinityId, timeoutMs) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        "X-Access-Token": token,
        [AFFINITY_HEADER]: affinityId,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      status: res.status,
      ms: Date.now() - t0,
      bodyHead: text.slice(0, 300),
      json,
    };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e), ms: Date.now() - t0 };
  }
}

(async () => {
  const out = { region: REGION, toolId: TOOL_ID, port: PORT };

  // 1) 复用或创建 Deployment
  const dName = process.env.TC_DEPLOYMENT_NAME || "rb-probe-deploy";
  const list = await client.DescribeDeploymentList({ Limit: 100 });
  let dpl = (list.DeploymentSet || []).find((d) => d.DeploymentName === dName);
  if (!dpl) {
    const body = {
      DeploymentName: dName,
      ToolId: TOOL_ID,
      ScalingConfiguration: { MinInstanceCount: 0, MaxInstanceCount: 3, MaxInstanceRequestConcurrency: 1 },
      LifecycleConfiguration: { IdleTimeoutSeconds: IDLE, IdleAction: "STOP" },
    };
    if (AFFINITY_MODE) body.AffinityConfiguration = { Mode: AFFINITY_MODE, HeaderName: AFFINITY_HEADER };
    try {
      const r = await client.CreateDeployment(body);
      dpl = r.Deployment;
      out.created = true;
    } catch (e) {
      out.createError = errInfo(e);
      console.log(JSON.stringify(out, null, 2));
      return;
    }
  } else {
    out.reused = true;
  }

  out.deploymentId = dpl.DeploymentId;
  const d = await waitDeployment(dpl.DeploymentId, 180000);
  out.deployment = {
    status: d.Status,
    statusReason: d.StatusReason,
    scaling: d.ScalingConfiguration,
    lifecycle: d.LifecycleConfiguration,
    affinity: d.AffinityConfiguration,
  };
  if (d.Status !== "ACTIVE") {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // 2) 拿 dpt token
  const tk = await client.AcquireDeploymentToken({ DeploymentId: dpl.DeploymentId });
  out.token = { prefix: String(tk.Token).slice(0, 4), length: String(tk.Token).length, expiresAt: tk.ExpiresAt };

  // 3) 探测 CDP
  const base = `https://${PORT}-${dpl.DeploymentId}.${REGION}.agents.${DOMAIN}`;
  out.baseHost = `${PORT}-${dpl.DeploymentId}.${REGION}.agents.${DOMAIN}`;

  const probe1 = await httpGet(`${base}/cdp/json/version`, tk.Token, "probe-sess-1", 90000);
  out.cdpVersion = {
    status: probe1.status,
    ms: probe1.ms,
    error: probe1.error,
    bodyHead: probe1.bodyHead,
  };
  if (probe1.json && probe1.json.webSocketDebuggerUrl) {
    out.ws1 = maskWsUrl(probe1.json.webSocketDebuggerUrl);
    out.browser = probe1.json.Browser;
  }

  // 4) 根路径对照
  const probe2 = await httpGet(`${base}/`, tk.Token, "probe-sess-1", 60000);
  out.root = { status: probe2.status, ms: probe2.ms, bodyHead: probe2.bodyHead };

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});