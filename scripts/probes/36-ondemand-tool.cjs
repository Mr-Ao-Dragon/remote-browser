/**
 * 探针 36：工具级「按需创建 + 用后删除」可行性
 * 1. 创建非持久工具，记录 CREATING → ACTIVE 耗时
 * 2. 立即删除，记录是否成功、列表何时消失
 * 3. 验证删除后同名可以重建（配额与命名约束）
 *
 * 用法：node scripts/probes/36-ondemand-tool.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const NAME = process.env.TC_PROBE_TOOL || `rb-ondemand-probe-${Date.now().toString(36)}`;
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

async function list() {
  const r = await client.DescribeSandboxToolList({ Limit: 100 });
  return r.SandboxToolSet || [];
}

async function find(toolId) {
  return (await list()).find((t) => t.ToolId === toolId);
}

async function waitStatus(toolId, wanted, timeoutMs) {
  const t0 = Date.now();
  let last = "UNKNOWN";
  while (Date.now() - t0 < timeoutMs) {
    const tool = await find(toolId);
    last = tool ? tool.Status : "GONE";
    if (wanted.includes(last)) return { status: last, ms: Date.now() - t0 };
    await sleep(2000);
  }
  return { status: last, ms: Date.now() - t0, timeout: true };
}

function customConfiguration() {
  return {
    Image: "ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest",
    ImageRegistryType: "custom",
    Command: ["/init"],
    Args: [
      "/bin/sh",
      "-c",
      "set -u; C=$(command -v chromium || command -v chromium-browser || command -v google-chrome); [ -z \"$C\" ] && exit 1; mkdir -p /tmp/cdpprofile; ( while true; do \"$C\" --headless=new --no-sandbox --disable-dev-shm-usage --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/tmp/cdpprofile about:blank >> /tmp/chrome.log 2>&1; sleep 1; done ) & exec sleep infinity",
    ],
    Ports: [{ Name: "web", Port: PORT, Protocol: "TCP" }],
    Resources: { CPU: "2", Memory: "4Gi" },
    Probe: {
      HttpGet: { Path: "/", Port: PORT, Scheme: "HTTP" },
      ReadyTimeoutMs: 30000,
      ProbeTimeoutMs: 3000,
      ProbePeriodMs: 2000,
      SuccessThreshold: 1,
      FailureThreshold: 10,
    },
  };
}

(async () => {
  const out = { name: NAME };

  const before = await list();
  out.toolsBefore = before.length;
  out.quota = { limit: 10, used: before.length };

  // ---- 1. 创建 ----
  const t0 = Date.now();
  let toolId;
  try {
    const created = await client.CreateSandboxTool({
      ToolName: NAME,
      ToolType: "custom",
      Description: "on-demand probe",
      NetworkConfiguration: { NetworkMode: "PUBLIC" },
      DefaultTimeout: "5m",
      Persistent: false,
      CustomConfiguration: customConfiguration(),
    });
    toolId = created.ToolId;
    out.create = { ok: true, toolId, submitMs: Date.now() - t0 };
  } catch (e) {
    out.create = { ok: false, submitMs: Date.now() - t0, error: errInfo(e) };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // ---- 2. 等 ACTIVE ----
  const active = await waitStatus(toolId, ["ACTIVE", "FAILED"], 300000);
  out.active = active;
  if (active.status !== "ACTIVE") {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // ---- 3. 删除 ----
  const t1 = Date.now();
  try {
    await client.DeleteSandboxTool({ ToolId: toolId });
    out.delete = { ok: true, submitMs: Date.now() - t1 };
  } catch (e) {
    out.delete = { ok: false, submitMs: Date.now() - t1, error: errInfo(e) };
  }

  if (out.delete.ok) {
    out.deleteGone = await waitStatus(toolId, ["GONE", "DELETING"], 120000);
    if (out.deleteGone.status === "DELETING") {
      out.deleteGone = await waitStatus(toolId, ["GONE"], 120000);
    }
  }

  // ---- 4. 同名重建 ----
  if (out.delete.ok) {
    const t2 = Date.now();
    try {
      const again = await client.CreateSandboxTool({
        ToolName: NAME,
        ToolType: "custom",
        Description: "on-demand probe (recreate)",
        NetworkConfiguration: { NetworkMode: "PUBLIC" },
        DefaultTimeout: "5m",
        Persistent: false,
        CustomConfiguration: customConfiguration(),
      });
      out.recreate = { ok: true, toolId: again.ToolId, submitMs: Date.now() - t2 };
      out.recreateActive = await waitStatus(again.ToolId, ["ACTIVE", "FAILED"], 300000);
      await client.DeleteSandboxTool({ ToolId: again.ToolId }).catch((e) => {
        out.recreateDeleteError = errInfo(e);
      });
      out.recreateDeleted = await waitStatus(again.ToolId, ["GONE", "DELETING"], 120000);
    } catch (e) {
      out.recreate = { ok: false, submitMs: Date.now() - t2, error: errInfo(e) };
    }
  }

  out.toolsAfter = (await list()).length;
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});