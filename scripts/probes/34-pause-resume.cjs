/**
 * 探针 34：暂停/恢复（带内存）是否保留浏览器状态 + TTL 续期
 * 用法：node scripts/probes/34-pause-resume.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");
const playwright = require("playwright-core");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DATA_PLANE_DOMAIN || "tencentags.com";
const TOOL_ID = process.env.TC_TOOL_ID || "sdt-gdf08rfu";
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
const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: String(e?.message || e).slice(0, 200) });

async function status(instanceId) {
  const r = await client.DescribeSandboxInstanceList({ InstanceIds: [instanceId], Limit: 10 }).catch(() => ({}));
  const i = (r.InstanceSet || [])[0] || {};
  return { status: i.Status, ttl: i.TimeoutSeconds, expiresAt: i.ExpiresAt, stopReason: i.StopReason };
}

async function waitStatus(instanceId, want, ms) {
  const t0 = Date.now();
  let s = {};
  while (Date.now() - t0 < ms) {
    s = await status(instanceId);
    if (want.includes(s.status)) return { ...s, ms: Date.now() - t0 };
    await sleep(1500);
  }
  return { ...s, ms: Date.now() - t0, timeout: true };
}

async function cdpVersion(instanceId, token, tries = 25) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(`https://${PORT}-${instanceId}.${REGION}.${DOMAIN}/cdp/json/version`, {
        headers: { "X-Access-Token": token },
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) return { ok: true, json: await res.json(), i };
    } catch {}
    await sleep(2000);
  }
  return { ok: false };
}

(async () => {
  const out = {};
  const t0 = Date.now();
  const inst = (await client.StartSandboxInstance({ ToolId: TOOL_ID, Timeout: "5m" })).Instance;
  out.start = { ms: Date.now() - t0, id: inst.InstanceId.slice(0, 8), status: inst.Status, ttl: inst.TimeoutSeconds };

  out.running = await waitStatus(inst.InstanceId, ["RUNNING"], 90000);
  const tk = await client.AcquireSandboxInstanceToken({ InstanceId: inst.InstanceId });
  out.ver1 = await cdpVersion(inst.InstanceId, tk.Token);

  // 建页面并导航，作为「暂停前状态」
  const b1 = await playwright.chromium.connectOverCDP(out.ver1.json.webSocketDebuggerUrl, {
    headers: { "X-Access-Token": tk.Token },
    timeout: 90000,
  });
  const ctx1 = b1.contexts()[0] || (await b1.newContext());
  const p1 = ctx1.pages()[0] || (await ctx1.newPage());
  await p1.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 60000 });
  const beforeTitle = await p1.title();
  await p1.evaluate(() => localStorage.setItem("rb_probe", "v42")).catch(() => {});
  await b1.close().catch(() => {});
  out.before = { title: beforeTitle };

  // TTL 续期
  const tUpd = Date.now();
  out.update = await client.UpdateSandboxInstance({ InstanceId: inst.InstanceId, Timeout: "10m" }).then(() => ({ ok: true, ms: Date.now() - tUpd })).catch(errInfo);
  out.afterUpdate = await status(inst.InstanceId);

  // 暂停（带内存）
  const tPause = Date.now();
  out.pause = await client.PauseSandboxInstance({ InstanceId: inst.InstanceId, Memory: true }).then((r) => ({ status: r.InstanceStatus, ms: Date.now() - tPause })).catch(errInfo);
  out.paused = await waitStatus(inst.InstanceId, ["PAUSED", "PAUSE_FAILED"], 120000);

  // 恢复
  const tResume = Date.now();
  out.resume = await client.ResumeSandboxInstance({ InstanceId: inst.InstanceId, Timeout: "5m" }).then(() => ({ ok: true })).catch(errInfo);
  out.resumed = await waitStatus(inst.InstanceId, ["RUNNING"], 120000);
  out.resumeLatencyMs = Date.now() - tResume;

  const ver2 = await cdpVersion(inst.InstanceId, tk.Token, 30);
  out.ver2 = { ok: ver2.ok, browser: ver2.json && ver2.json.Browser };
  if (ver2.ok) {
    try {
      const b2 = await playwright.chromium.connectOverCDP(ver2.json.webSocketDebuggerUrl, {
        headers: { "X-Access-Token": tk.Token },
        timeout: 90000,
      });
      const pages = b2.contexts().flatMap((c) => c.pages());
      out.afterResume = {
        contexts: b2.contexts().length,
        pages: pages.map((p) => p.url()),
        title: await pages[0]?.title().catch(() => null),
        localStorage: await pages[0]?.evaluate(() => localStorage.getItem("rb_probe")).catch((e) => "ERR:" + e.message.slice(0, 60)),
      };
      await b2.close().catch(() => {});
    } catch (e) {
      out.afterResume = { error: String(e?.message || e).split("\n")[0].slice(0, 200) };
    }
  }

  out.stop = await client.StopSandboxInstance({ InstanceId: inst.InstanceId }).then(() => ({ ok: true })).catch(errInfo);
  out.final = await waitStatus(inst.InstanceId, ["STOPPED"], 60000);

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});