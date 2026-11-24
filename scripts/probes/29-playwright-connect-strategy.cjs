/**
 * 探针 29：定位 Playwright 连接方式（http base vs 重写 wss）
 * 用法：node scripts/probes/29-playwright-connect-strategy.js [deploymentId]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DATA_PLANE_DOMAIN || "tencentags.com";
const DPL = process.argv[2] || process.env.TC_DEPLOYMENT_ID || "dpl-kgw27cnt";
const HEADER = process.env.TC_AFFINITY_HEADER || "X-Rb-Affinity";
const SESS = "sess-pw-1";

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

const short = (s) => String(s || "").slice(0, 220);

(async () => {
  const out = { node: process.version };
  const tk = await client.AcquireDeploymentToken({ DeploymentId: DPL });
  const headers = { "X-Access-Token": tk.Token, [HEADER]: SESS };
  const host = `9000-${DPL}.${REGION}.agents.${DOMAIN}`;
  const httpBase = `https://${host}`;

  const ver = await fetch(`${httpBase}/cdp/json/version`, { headers, signal: AbortSignal.timeout(60000) }).then(
    async (r) => ({ status: r.status, json: await r.json().catch(() => null) })
  );
  out.versionStatus = ver.status;
  const rawWs = ver.json && ver.json.webSocketDebuggerUrl;
  out.rawWsShape = String(rawWs || "").replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/<uuid>");

  const playwright = require("playwright-core");

  // A: 文档方式，base 指向 /cdp
  const tA = Date.now();
  try {
    const b = await playwright.chromium.connectOverCDP(`${httpBase}/cdp`, { headers, timeout: 90000 });
    out.A_httpCdpPrefix = { ok: true, ms: Date.now() - tA, contexts: b.contexts().length };
    await b.close().catch(() => {});
  } catch (e) {
    out.A_httpCdpPrefix = { ok: false, ms: Date.now() - tA, error: short(String(e?.message || e).split("\n")[0]) };
  }

  // B: 把内网 wss 重写为公网部署入口（raw path 已含 /cdp，无需再加前缀）
  let rewritten;
  if (rawWs) {
    const m = /^wss?:\/\/[^/]+(\/.*)$/.exec(rawWs);
    rewritten = m ? `wss://${host}${m[1]}` : null;
  }
  out.rewrittenWsShape = String(rewritten || "").replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/<uuid>");
  if (rewritten) {
    const tB = Date.now();
    try {
      const b = await playwright.chromium.connectOverCDP(rewritten, { headers, timeout: 90000 });
      out.B_rewrittenWs = { ok: true, ms: Date.now() - tB, contexts: b.contexts().length };
      const ctx = b.contexts()[0] || (await b.newContext());
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 60000 });
      out.B_navigate = { url: page.url(), title: await page.title() };
      const shot = await page.screenshot({ type: "png" });
      out.B_screenshotBytes = shot.length;
      await b.close().catch(() => {});
    } catch (e) {
      out.B_rewrittenWs = { ok: false, ms: Date.now() - tB, error: short(String(e?.message || e).split("\n")[0]) };
    }
  }

  // C: 裸 WebSocket 握手（B 关闭后单独验证，避免并发=1 冲突）
  if (rawWs && typeof WebSocket !== "undefined") {
    const url = rewritten;
    const tC = Date.now();
    out.C_rawWs = await new Promise((resolve) => {
      const ws = new WebSocket(url, { headers });
      const done = (v) => resolve({ ms: Date.now() - tC, ...v });
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        done({ ok: false, error: "timeout" });
      }, 20000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
      ws.onmessage = (ev) => {
        clearTimeout(timer);
        const msg = JSON.parse(String(ev.data));
        try { ws.close(); } catch {}
        done({ ok: true, browser: msg.result && msg.result.product });
      };
      ws.onerror = (ev) => {
        clearTimeout(timer);
        done({ ok: false, error: short(ev?.message || "ws error") });
      };
    });
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: short(String(e?.message || e)) }, null, 2));
  process.exit(1);
});