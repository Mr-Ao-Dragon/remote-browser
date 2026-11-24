/**
 * 探针 20：修正启动参数后的浏览器工具 + 直连实例验证
 *
 * 与 sdt-oo1phxia 的差别：不再覆盖 Args 为 sleep infinity，让 /init 正常拉起服务。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DOMAIN || "tencentags.com";
const TOOL_NAME = process.env.TC_TOOL_NAME || "rb-browser-persist2";
const IMAGE = process.env.TC_IMAGE || "ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest";
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
const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: String(e?.message || e).slice(0, 300) });

(async () => {
  const out = {};

  // 1) 工具
  const exist = await client.DescribeSandboxToolList({ Limit: 100 });
  let tool = (exist.SandboxToolSet || []).find((t) => t.ToolName === TOOL_NAME);
  if (!tool) {
    const r = await client.CreateSandboxTool({
      ToolName: TOOL_NAME,
      ToolType: "custom",
      NetworkConfiguration: { NetworkMode: "PUBLIC" },
      Persistent: true,
      DefaultTimeout: "30m",
      Description: "persistent browser sandbox, /init as-is",
      CustomConfiguration: {
        Image: IMAGE,
        ImageRegistryType: "custom",
        Command: ["/init"],
        Ports: [
          { Name: "cdp", Port: 9000, Protocol: "TCP" },
          { Name: "envd", Port: 49983, Protocol: "TCP" },
        ],
        Resources: { CPU: "2", Memory: "4Gi" },
        Probe: {
          HttpGet: { Path: "/", Port: 9000, Scheme: "HTTP" },
          ReadyTimeoutMs: 30000,
          ProbeTimeoutMs: 3000,
          ProbePeriodMs: 2000,
          SuccessThreshold: 1,
          FailureThreshold: 15,
        },
      },
    });
    tool = { ToolId: r.ToolId, Status: "CREATING" };
    out.created = r.ToolId;
  } else {
    out.reused = tool.ToolId;
  }

  let cur = tool;
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    const q = await client.DescribeSandboxToolList({ ToolIds: [tool.ToolId], Limit: 1 });
    cur = (q.SandboxToolSet || [])[0] || cur;
    if (["ACTIVE", "FAILED"].includes(cur.Status)) break;
    await sleep(3000);
  }
  out.tool = { toolId: tool.ToolId, status: cur.Status, statusReason: cur.StatusReason };
  if (cur.Status !== "ACTIVE") {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // 2) 实例
  const inst = await client.StartSandboxInstance({
    ToolId: tool.ToolId,
    Timeout: "10m",
    AuthMode: "PUBLIC",
  });
  const instanceId = inst.Instance && inst.Instance.InstanceId;
  out.instanceId = instanceId;

  let s = {};
  const t1 = Date.now();
  while (Date.now() - t1 < 180000) {
    const q = await client.DescribeSandboxInstanceList({ InstanceIds: [instanceId], Limit: 1 });
    s = (q.InstanceSet || [])[0] || s;
    if (["RUNNING", "FAILED", "STOPPED"].includes(s.Status)) break;
    await sleep(3000);
  }
  out.instanceStatus = s.Status;
  out.instanceStatusReason = s.StatusReason;
  out.startElapsedMs = Date.now() - t1;
  out.serviceInfo = s.ServiceInfo ? JSON.stringify(s.ServiceInfo).slice(0, 400) : undefined;

  if (s.Status !== "RUNNING") {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // 3) 探测 9000
  const base = `https://${PORT}-${instanceId}.${REGION}.${DOMAIN}`;
  const tk = await client.AcquireSandboxInstanceToken({ InstanceId: instanceId });
  out.tokenLen = String(tk.Token || "").length;

  for (const p of ["/", "/cdp/json/version", "/cdp/"]) {
    const t2 = Date.now();
    try {
      const res = await fetch(base + p, {
        headers: { "X-Access-Token": tk.Token },
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      out["probe" + p] = { status: res.status, ms: Date.now() - t2, head: text.slice(0, 260) };
    } catch (e) {
      out["probe" + p] = { error: String(e?.message || e), ms: Date.now() - t2 };
    }
  }

  out.stopNote = "实例保持运行，空闲回收/停机由后续探针验证";
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});