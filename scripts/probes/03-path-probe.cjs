/**
 * 探针 03：在既有实例上探测可能的 CDP / 控制路径
 * 用法：TC_INSTANCE_ID=xxx node scripts/probes/03-path-probe.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DOMAIN || "tencentags.com";
const INSTANCE_ID = process.env.TC_INSTANCE_ID;

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

const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: e?.message || String(e) });

async function httpProbe(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "manual" });
    const text = await res.text().catch(() => "");
    return { status: res.status, body: text.slice(0, 200) };
  } catch (e) {
    return { error: `${e.name}: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  if (!INSTANCE_ID) throw new Error("TC_INSTANCE_ID required");

  const tr = await client.AcquireSandboxInstanceToken({ InstanceId: INSTANCE_ID });
  const token = tr.Token;
  const hdr = { "X-Access-Token": token };
  const base = (port) => `https://${port}-${INSTANCE_ID}.${REGION}.${DOMAIN}`;

  const paths = [
    [9000, "/novnc/"],
    [9000, "/vnc.html"],
    [9000, "/cdp/"],
    [9000, "/cdp/json/version"],
    [9000, "/json"],
    [9000, "/health"],
    [5000, "/"],
    [5000, "/screenshot"],
    [5000, "/setup/launch"],
    [5000, "/platform"],
    [9222, "/json"],
    [49983, "/"],
    [49983, "/v1/metadata"],
  ];

  const out = [];
  for (const [port, p] of paths) {
    const url = `${base(port)}${p}`;
    const r = await httpProbe(url, hdr);
    out.push({ port, path: p, ...r });
  }

  console.log(JSON.stringify({ ok: true, instanceId: INSTANCE_ID, probes: out }, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: errInfo(e) }));
  process.exit(1);
});