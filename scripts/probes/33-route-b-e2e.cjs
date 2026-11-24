/**
 * 探针 33：路线 B —— 实例级生命周期 + Playwright 端到端 + 幂等停机
 * 用法：node scripts/probes/33-route-b-e2e.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DATA_PLANE_DOMAIN || "tencentags.com";
const TOOL_ID = process.env.TC_TOOL_ID || "sdt-gdf08rfu";
const TTL = process.env.TC_TTL || "10m";
const PORT = 9000;

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
const shape = (u) => String(u || "").replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/<uuid>");

async function waitRunning(instanceId, ms) {
  const t0 = Date.now();
  let st = "UNKNOWN";
  while (Date.now() - t0 < ms) {
    const r = await client.DescribeSandboxInstanceList({ InstanceIds: [instanceId], Limit: 10 }).catch(() => ({}));
    const it = (r.InstanceSet || [])[0];
    st = it && it.Status;
    if (st === "RUNNING") return { status: st, ms: Date.now() - t0 };
    if (st === "FAILED" || st === "STOPPED") return { status: st, ms: Date.now() - t0 };
    await sleep(1000);
  }
  return { status: st, ms: Date.now() - t0, timeout: true };
}

async function fetchJson(url, token, tries = 20, gap = 2000) {
  const trace = [];
  for (let i = 1; i <= tries; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers: { "X-Access-Token": token }, signal: AbortSignal.timeout(45000) });
      const text = await res.text();
      trace.push({ i, status: res.status, ms: Date.now() - t0 });
      if (res.ok) {
        try {
          return { ok: true, json: JSON.parse(text), trace };
        } catch {
          return { ok: true, text: text.slice(0, 80), trace };
        }
      }
      if (![502, 503, 504].includes(res.status)) return { ok: false, status: res.status, body: text.slice(0, 100), trace };
    } catch (e) {
      trace.push({ i, error: String(e?.message || e).slice(0, 60) });
    }
    await sleep(gap);
  }
  return { ok: false, trace };
}

(async () => {
  const out = {};
  const tStart = Date.now();
  const started = await client.StartSandboxInstance({ ToolId: TOOL_ID, Timeout: TTL });
  const inst = started.Instance;
  out.start = { ms: Date.now() - tStart, instanceId: inst.InstanceId.slice(0, 8), status: inst.Status };

  const run = await waitRunning(inst.InstanceId, 90000);
  out.running = run;

  const tk = await client.AcquireSandboxInstanceToken({ InstanceId: inst.InstanceId });
  out.token = {
    tokenPrefix: String(tk.Token || "").slice(0, 4),
    tokenLen: String(tk.Token || "").length,
    trafficPrefix: String(tk.TrafficToken || "").slice(0, 4),
    trafficLen: String(tk.TrafficToken || "").length,
    expiresAt: tk.ExpiresAt,
  };

  const host = `${PORT}-${inst.InstanceId}.${REGION}.${DOMAIN}`;
  const base = `https://${host}`;
  const useToken = process.env.TC_USE_TRAFFIC_TOKEN ? tk.TrafficToken : tk.Token;
  out.whichToken = process.env.TC_USE_TRAFFIC_TOKEN ? "TrafficToken" : "Token";

  const ver = await fetchJson(`${base}/cdp/json/version`, useToken);
  out.version = { ok: ver.ok, status: ver.status, browser: ver.json && ver.json.Browser, ws: shape(ver.json && ver.json.webSocketDebuggerUrl), trace: ver.trace };

  if (ver.ok && ver.json && ver.json.webSocketDebuggerUrl) {
    const playwright = require("playwright-core");
    const wsUrl = ver.json.webSocketDebuggerUrl; // 期望公网可解析
    out.wsHostPublic = /\.tencentags\.com\//.test(wsUrl) && !/\.internal\./.test(wsUrl);
    const tC = Date.now();
    try {
      const browser = await playwright.chromium.connectOverCDP(wsUrl, { headers: { "X-Access-Token": useToken }, timeout: 90000 });
      out.connect = { ok: true, ms: Date.now() - tC };
      const ctx = browser.contexts()[0] || (await browser.newContext());
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 60000 });
      out.navigate = { url: page.url(), title: await page.title() };
      out.screenshotBytes = (await page.screenshot({ type: "png" })).length;
      out.h1Text = (await page.locator("h1").first().innerText().catch(() => null)) || null;
      await browser.close().catch(() => {});
    } catch (e) {
      out.connect = { ok: false, ms: Date.now() - tC, error: String(e?.message || e).split("\n")[0].slice(0, 240) };
    }
  }

  // 幂等停机：连续两次 Stop
  const tStop = Date.now();
  const s1 = await client.StopSandboxInstance({ InstanceId: inst.InstanceId }).then(() => ({ ok: true })).catch((e) => errInfo(e));
  out.stop1 = { ...s1, ms: Date.now() - tStop };
  const s2 = await client.StopSandboxInstance({ InstanceId: inst.InstanceId }).then(() => ({ ok: true })).catch((e) => errInfo(e));
  out.stop2 = s2;

  // 停机后 Token 立即失效
  await sleep(3000);
  out.afterStop = await fetchJson(`${base}/cdp/json/version`, useToken, 1, 1000);
  out.afterStop.body = out.afterStop.body ? String(out.afterStop.body).replace(/[A-Za-z0-9_-]{20,}/g, "***") : out.afterStop.body;

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});