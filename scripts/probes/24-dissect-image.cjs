/**
 * 探针 24：解剖 sandbox-browser 镜像
 * 用 Command 覆盖把镜像自检结果写到 nginx 静态目录，再从 9000 读回来。
 * 目的：确认是否自带 Chromium、/init 行为、nginx 反代配置。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DOMAIN || "tencentags.com";
const TOOL_NAME = process.env.TC_TOOL_NAME || "rb-diag";
const IMAGE = process.env.TC_IMAGE || "ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest";

const SCRIPT = [
  "(" + "/init" + " &) ; sleep 4;",
  "{ echo '=== uname ==='; uname -a;",
  "  echo '=== /init ==='; head -c 3000 /init; echo;",
  "  echo '=== bins ==='; for b in chromium chromium-browser google-chrome google-chrome-stable node npm python3 nginx Xvfb x11vnc websockify supervisord; do printf '%s -> ' \\$b; command -v \\$b || echo MISSING; done;",
  "  echo '=== / ==='; ls -la /;",
  "  echo '=== /opt ==='; ls -la /opt 2>/dev/null;",
  "  echo '=== /etc/nginx ==='; ls -la /etc/nginx 2>/dev/null; cat /etc/nginx/nginx.conf 2>/dev/null;",
  "  echo '=== nginx conf.d ==='; cat /etc/nginx/conf.d/*.conf 2>/dev/null | head -80;",
  "  echo '=== s6 services ==='; ls -la /etc/services.d 2>/dev/null; ls -la /etc/s6-overlay 2>/dev/null;",
  "} > /usr/share/nginx/html/probe.html 2>&1;",
  "sleep infinity",
].join(" ");

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
const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: String(e?.message || e).slice(0, 260) });

(async () => {
  const out = {};

  const exist = await client.DescribeSandboxToolList({ Limit: 100 });
  let tool = (exist.SandboxToolSet || []).find((t) => t.ToolName === TOOL_NAME);
  if (!tool) {
    const r = await client.CreateSandboxTool({
      ToolName: TOOL_NAME,
      ToolType: "custom",
      NetworkConfiguration: { NetworkMode: "PUBLIC" },
      Persistent: true,
      DefaultTimeout: "10m",
      Description: "diagnostic shell over nginx",
      CustomConfiguration: {
        Image: IMAGE,
        ImageRegistryType: "custom",
        Command: ["/bin/sh", "-c", SCRIPT],
        Ports: [{ Name: "web", Port: 9000, Protocol: "TCP" }],
        Resources: { CPU: "2", Memory: "4Gi" },
        Probe: {
          HttpGet: { Path: "/", Port: 9000, Scheme: "HTTP" },
          ReadyTimeoutMs: 30000,
          ProbeTimeoutMs: 3000,
          ProbePeriodMs: 2000,
          SuccessThreshold: 1,
          FailureThreshold: 10,
        },
      },
    });
    tool = { ToolId: r.ToolId };
    out.created = r.ToolId;
  } else {
    out.reused = tool.ToolId;
  }

  let cur = {};
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
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

  const inst = await client.StartSandboxInstance({ ToolId: tool.ToolId, Timeout: "10m", AuthMode: "PUBLIC" });
  const instanceId = inst.Instance.InstanceId;
  out.instanceId = instanceId;

  let s = {};
  const t1 = Date.now();
  while (Date.now() - t1 < 120000) {
    const q = await client.DescribeSandboxInstanceList({ InstanceIds: [instanceId], Limit: 1 });
    s = (q.InstanceSet || [])[0] || s;
    if (["RUNNING", "FAILED", "STOPPED"].includes(s.Status)) break;
    await sleep(2000);
  }
  out.status = s.Status;

  const tk = await client.AcquireSandboxInstanceToken({ InstanceId: instanceId });
  const base = `https://9000-${instanceId}.${REGION}.${DOMAIN}`;
  for (const p of ["/", "/probe.html"]) {
    try {
      const res = await fetch(base + p, { headers: { "X-Access-Token": tk.Token }, signal: AbortSignal.timeout(25000) });
      const text = await res.text();
      out["get" + p] = { status: res.status, body: text.slice(0, 4000) };
    } catch (e) {
      out["get" + p] = { error: String(e?.message || e) };
    }
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});