/**
 * 探针 35：非持久 custom 工具 + TTL 自动回收 + 暂停恢复
 * 用法：node scripts/probes/35-ephemeral-ttl.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DATA_PLANE_DOMAIN || "tencentags.com";
const SRC_TOOL = process.env.TC_SRC_TOOL || "sdt-gdf08rfu";
const NEW_NAME = process.env.TC_NEW_TOOL || "rb-chrome-ephemeral";
const PORT = 9000;
const TOOL_TTL = process.env.TC_TOOL_TTL || "5m";
const TTL = process.env.TC_TTL || "2m";

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
const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: String(e?.message || e).slice(0, 220) });

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
    await sleep(2000);
  }
  return { ...s, ms: Date.now() - t0, timeout: true };
}

async function cdpVersion(instanceId, token, tries = 20) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(`https://${PORT}-${instanceId}.${REGION}.${DOMAIN}/cdp/json/version`, {
        headers: { "X-Access-Token": token },
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) return { ok: true, json: await res.json(), i };
      if (res.status === 404) return { ok: false, status: 404 };
    } catch {}
    await sleep(2000);
  }
  return { ok: false };
}

(async () => {
  const out = { ttl: TTL };
  const list = await client.DescribeSandboxToolList({ Limit: 100 });
  const src = (list.SandboxToolSet || []).find((t) => t.ToolId === SRC_TOOL);
  if (!src) throw new Error("source tool not found");
  let tool = (list.SandboxToolSet || []).find((t) => t.ToolName === NEW_NAME);

  // 只保留可写字段，剔除 ImageDigest 等只读属性
  const srcConf = src.CustomConfiguration || {};
  const customConf = {
    Image: srcConf.Image,
    ImageRegistryType: srcConf.ImageRegistryType,
    Command: srcConf.Command,
    Args: srcConf.Args,
    Env: srcConf.Env,
    Ports: srcConf.Ports,
    Resources: srcConf.Resources,
    Probe: srcConf.Probe,
  };
  for (const k of Object.keys(customConf)) if (customConf[k] === undefined) delete customConf[k];

  if (!tool) {
    try {
      const created = await client.CreateSandboxTool({
        ToolName: NEW_NAME,
        ToolType: "custom",
        Description: "ephemeral browser sandbox (TTL safety net)",
        NetworkConfiguration: { NetworkMode: "PUBLIC" },
        DefaultTimeout: TOOL_TTL,
        Persistent: false,
        CustomConfiguration: customConf,
      });
      tool = { ToolId: created.ToolId, ToolName: NEW_NAME, Persistent: false, Status: "CREATING" };
      out.toolCreated = true;
    } catch (e) {
      out.createToolError = errInfo(e);
      console.log(JSON.stringify(out, null, 2));
      return;
    }
  }
  out.tool = { id: tool.ToolId, persistent: tool.Persistent, status: tool.Status, defaultTimeoutSeconds: tool.DefaultTimeoutSeconds };

  // 等工具 ACTIVE
  for (let i = 0; i < 40; i++) {
    const arr = (await client.DescribeSandboxToolList({ Limit: 100 })).SandboxToolSet || [];
    const t = arr.find((x) => x.ToolId === tool.ToolId);
    out.tool.status = t && t.Status;
    if (t && t.Status === "ACTIVE") break;
    if (t && t.Status === "FAILED") {
      out.tool.statusReason = t.StatusReason;
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    await sleep(3000);
  }

  const t0 = Date.now();
  const inst = (await client.StartSandboxInstance({ ToolId: tool.ToolId, Timeout: TTL })).Instance;
  out.start = { ms: Date.now() - t0, id: inst.InstanceId.slice(0, 8), status: inst.Status, timeoutSeconds: inst.TimeoutSeconds, expiresAt: inst.ExpiresAt };

  out.running = await waitStatus(inst.InstanceId, ["RUNNING", "FAILED"], 120000);
  if (out.running.status !== "RUNNING") {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const tk = await client.AcquireSandboxInstanceToken({ InstanceId: inst.InstanceId });
  out.ver = await cdpVersion(inst.InstanceId, tk.Token);

  // 暂停（内存）→ 恢复，验证非持久工具是否支持
  out.pause = await client.PauseSandboxInstance({ InstanceId: inst.InstanceId, Memory: true }).then((r) => ({ status: r.InstanceStatus })).catch(errInfo);
  out.paused = await waitStatus(inst.InstanceId, ["PAUSED", "PAUSE_FAILED"], 120000);
  if (out.paused.status === "PAUSED") {
    out.resume = await client.ResumeSandboxInstance({ InstanceId: inst.InstanceId, Timeout: TTL }).then(() => ({ ok: true })).catch(errInfo);
    out.resumed = await waitStatus(inst.InstanceId, ["RUNNING"], 120000);
    out.verAfterResume = { ok: (await cdpVersion(inst.InstanceId, tk.Token, 15)).ok };
  }

  // 不手动停机，等 TTL 到期
  out.waitTtl = await waitStatus(inst.InstanceId, ["STOPPED", "FAILED", "STOP_FAILED"], 180000);

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});