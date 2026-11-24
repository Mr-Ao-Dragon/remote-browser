/**
 * 探针 02：实例直连——启动 browser 实例，探测数据面端口与 CDP 形态
 * 验证：端口可达性、AuthMode=PUBLIC 的实际效果、/json/version 与 /cdp、Affinity 头是否出现。
 * 不打印任何 Token。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DOMAIN || "tencentags.com";
const TOOL_ID = process.env.TC_TOOL_ID || "sdt-b2pwk0dm";
const TIMEOUT = process.env.TC_INSTANCE_TIMEOUT || "5m";

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

async function waitRunning(instanceId, timeoutMs = 180000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    const r = await client.DescribeSandboxInstanceList({ InstanceIds: [instanceId], Limit: 10 });
    const inst = (r.InstanceSet || [])[0];
    if (inst) {
      last = inst;
      if (inst.Status === "RUNNING") return inst;
      if (["FAILED", "STOPPED", "STOP_FAILED"].includes(inst.Status)) {
        throw new Error(`instance ${inst.Status}`);
      }
    }
    await sleep(3000);
  }
  throw new Error(`instance running timeout, last=${JSON.stringify(last)}`);
}

async function httpProbe(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "manual" });
    const text = await res.text().catch(() => "");
    const h = {};
    for (const [k, v] of res.headers.entries()) h[k] = v;
    return {
      status: res.status,
      ms: Date.now() - started,
      headers: h,
      body: text.slice(0, 400),
    };
  } catch (e) {
    return { error: `${e.name}: ${e.message}`, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  let inst;
  try {
    const r = await client.StartSandboxInstance({
      ToolId: TOOL_ID,
      Timeout: TIMEOUT,
      AuthMode: process.env.TC_AUTH_MODE || "PUBLIC",
      ClientToken: `rb-probe-inst-${Date.now()}`,
    });
    inst = r.Instance;
  } catch (e) {
    console.error(JSON.stringify({ ok: false, stage: "start", error: errInfo(e) }));
    process.exit(1);
  }

  const instanceId = inst.InstanceId;
  inst = await waitRunning(instanceId);

  let token;
  try {
    const tr = await client.AcquireSandboxInstanceToken({ InstanceId: instanceId });
    token = tr.Token;
  } catch (e) {
    console.error(JSON.stringify({ ok: false, stage: "token", error: errInfo(e) }));
  }

  const base = (port) => `https://${port}-${instanceId}.${REGION}.${DOMAIN}`;
  const hdr = token ? { "X-Access-Token": token } : {};
  const q = token ? `?access_token=${encodeURIComponent(token)}` : "";

  const probes = {
    "9000_root_noauth": await httpProbe(`${base(9000)}/`),
    "9000_json_version_noauth": await httpProbe(`${base(9000)}/json/version`),
    "9000_json_version_hdr": await httpProbe(`${base(9000)}/json/version`, hdr),
    "9000_cdp_get_hdr": await httpProbe(`${base(9000)}/cdp`, hdr),
    "9222_json_version_noauth": await httpProbe(`${base(9222)}/json/version`),
    "9222_json_version_hdr": await httpProbe(`${base(9222)}/json/version`, hdr),
    "49983_health_noauth": await httpProbe(`${base(49983)}/health`),
    "49983_health_hdr": await httpProbe(`${base(49983)}/health`, hdr),
    "9000_json_version_query": await httpProbe(`${base(9000)}/json/version${q}`),
  };

  // 只保留有价值的信息，避免日志过长
  const summary = {
    ok: true,
    region: REGION,
    instanceId,
    status: inst.Status,
    expiresAt: inst.ExpiresAt,
    authMode: inst.AuthMode,
    persistent: inst.Persistent,
    tokenAcquired: Boolean(token),
    tokenLength: token ? token.length : 0,
    probes,
  };
  console.log(JSON.stringify(summary, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, stage: "fatal", error: errInfo(e) }));
  process.exit(1);
});