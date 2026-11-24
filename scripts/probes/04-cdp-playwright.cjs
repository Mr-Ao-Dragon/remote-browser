/**
 * 探针 04：Playwright over CDP 端到端验证
 * 1) 确保有 RUNNING 实例（没有则起一个）
 * 2) 从 /cdp/json/version 拿 webSocketDebuggerUrl
 * 3) connect_over_cdp -> goto -> title
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");
const { chromium } = require("playwright-core");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DOMAIN || "tencentags.com";
const TOOL_ID = process.env.TC_TOOL_ID || "sdt-b2pwk0dm";
const TARGET = process.env.TC_TARGET_URL || "https://example.com";

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
      if (["FAILED", "STOPPED", "STOP_FAILED"].includes(inst.Status)) throw new Error(`instance ${inst.Status}`);
    }
    await sleep(3000);
  }
  throw new Error(`timeout last=${JSON.stringify(last)}`);
}

async function ensureInstance() {
  if (process.env.TC_INSTANCE_ID) {
    const r = await client.DescribeSandboxInstanceList({ InstanceIds: [process.env.TC_INSTANCE_ID], Limit: 10 });
    const i = (r.InstanceSet || [])[0];
    if (i && i.Status === "RUNNING") return i;
  }
  const r = await client.StartSandboxInstance({
    ToolId: TOOL_ID,
    Timeout: "10m",
    AuthMode: "PUBLIC",
    ClientToken: `rb-probe-cdp-${Date.now()}`,
  });
  return waitRunning(r.Instance.InstanceId);
}

(async () => {
  const inst = await ensureInstance();
  const base = `https://9000-${inst.InstanceId}.${REGION}.${DOMAIN}`;

  const verRes = await fetch(`${base}/cdp/json/version`, { signal: AbortSignal.timeout(10000) });
  const ver = await verRes.json();
  const wsUrl = ver.webSocketDebuggerUrl;

  const started = Date.now();
  let browser;
  try {
    browser = await chromium.connectOverCDP(wsUrl, { timeout: 30000 });
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = ctx.pages()[0] || (await ctx.newPage());
    const resp = await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 30000 });
    const title = await page.title();
    const finalUrl = page.url();

    console.log(
      JSON.stringify(
        {
          ok: true,
          instanceId: inst.InstanceId,
          browserVersion: ver.Browser,
          wsHost: new URL(wsUrl).host,
          wsPathPrefix: new URL(wsUrl).pathname.split("/devtools/")[0],
          target: TARGET,
          httpStatus: resp ? resp.status() : null,
          title,
          finalUrl,
          elapsedMs: Date.now() - started,
        },
        null,
        2
      )
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: errInfo(e) }));
  process.exit(1);
});