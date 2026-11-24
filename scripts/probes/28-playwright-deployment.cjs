/**
 * 探针 28：Playwright 经部署入口 connectOverCDP 端到端（P1）
 * 用法：node scripts/probes/28-playwright-deployment.js [deploymentId]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DATA_PLANE_DOMAIN || "tencentags.com";
const DPL = process.argv[2] || process.env.TC_DEPLOYMENT_ID || "dpl-kgw27cnt";
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

// 只保留形态，隐藏 uuid
const shape = (u) => String(u || "").replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/<uuid>");

// 冷启动期间入口会先返回 502，需要重试等待实例就绪
async function fetchJson(url, headers, tries = 20, gapMs = 3000) {
  const trace = [];
  for (let i = 1; i <= tries; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {}
      trace.push({ i, status: res.status, ms: Date.now() - t0, json: !!json });
      if (res.ok && json) return { ok: true, status: res.status, json, trace };
      if (res.status !== 502 && res.status !== 503 && res.status !== 504 && res.status !== 409) {
        return { ok: false, status: res.status, text: text.slice(0, 120), trace };
      }
    } catch (e) {
      trace.push({ i, error: String(e?.message || e).slice(0, 80), ms: Date.now() - t0 });
    }
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return { ok: false, trace };
}

(async () => {
  const out = {};
  const tk = await client.AcquireDeploymentToken({ DeploymentId: DPL });
  out.tokenPrefix = String(tk.Token).slice(0, 4);
  out.tokenExpires = tk.ExpiresAt;

  const base = `https://9000-${DPL}.${REGION}.agents.${DOMAIN}`;
  const headers = { "X-Access-Token": tk.Token, [HEADER]: "sess-pw-1" };

  const ver = await fetchJson(`${base}/cdp/json/version`, headers);
  out.version = { ok: ver.ok, status: ver.status, browser: ver.json && ver.json.Browser, ws: shape(ver.json && ver.json.webSocketDebuggerUrl), trace: ver.trace };

  const lst = await fetchJson(`${base}/cdp/json/list`, headers);
  out.list = { ok: lst.ok, status: lst.status, targets: (lst.json || []).map((t) => ({ type: t.type, ws: shape(t.webSocketDebuggerUrl) })) };

  let playwright;
  try {
    playwright = require("playwright-core");
  } catch (e) {
    out.playwrightMissing = String(e.message);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const t0 = Date.now();
  try {
    const browser = await playwright.chromium.connectOverCDP(base, { headers, timeout: 120000 });
    out.connected = { ok: true, ms: Date.now() - t0, contexts: browser.contexts().length };
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 60000 });
    out.navigate = { url: page.url(), title: await page.title() };
    const shot = await page.screenshot({ type: "png" });
    out.screenshot = { bytes: shot.length };
    await browser.close().catch(() => {});
  } catch (e) {
    out.connected = { ok: false, ms: Date.now() - t0, error: String(e?.message || e).split("\n")[0].slice(0, 300) };
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: String(e?.message || e) }, null, 2));
  process.exit(1);
});