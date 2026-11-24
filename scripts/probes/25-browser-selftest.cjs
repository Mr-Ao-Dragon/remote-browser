/**
 * 探针 25：在 sandbox-browser 镜像里自己拉起 Chrome，并输出镜像自检信息
 *
 * 思路：
 *  - Command 保持 /init（这样才能启动 nginx 与 envd）
 *  - Args 传入一个 shell，把自检结果写到 nginx 静态目录，并尝试启动 Chromium 到 9222
 *  - nginx 的 /cdp 预计反代 9222，因此仍只需要 9000 一个端口
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const DOMAIN = process.env.TC_DOMAIN || "tencentags.com";
const TOOL_NAME = process.env.TC_TOOL_NAME || "rb-chrome-selftest";
const IMAGE = process.env.TC_IMAGE || "ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest";

const SCRIPT = [
  "D=/usr/share/nginx/html;",
  "{ echo '=== bins ===';",
  "for b in chromium chromium-browser google-chrome google-chrome-stable node python3 nginx Xvfb; do printf '%s -> ' $b; command -v $b || echo MISSING; done;",
  "echo '=== /opt ==='; ls /opt 2>&1;",
  "echo '=== nginx conf ==='; grep -rE 'listen|proxy_pass|root ' /etc/nginx/ 2>/dev/null | head -40;",
  "} > $D/probe.html 2>&1;",
  "C=$(command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable);",
  "echo \"chrome=$C\" >> $D/probe.html;",
  "if [ -n \"$C\" ]; then nohup $C --headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/tmp/cdpprofile about:blank > /tmp/chrome.log 2>&1 & fi;",
  "sleep 5; echo '=== chrome.log ===' >> $D/probe.html; tail -20 /tmp/chrome.log >> $D/probe.html 2>&1;",
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
      DefaultTimeout: "15m",
      Description: "browser image self-test + own chrome",
      CustomConfiguration: {
        Image: IMAGE,
        ImageRegistryType: "custom",
        Command: ["/init"],
        Args: ["/bin/sh", "-c", SCRIPT],
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

  const inst = await client.StartSandboxInstance({ ToolId: tool.ToolId, Timeout: "15m", AuthMode: "PUBLIC" });
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
  out.statusReason = s.StatusReason;

  const tk = await client.AcquireSandboxInstanceToken({ InstanceId: instanceId });
  const base = `https://9000-${instanceId}.${REGION}.${DOMAIN}`;
  const get = async (p) => {
    try {
      const res = await fetch(base + p, { headers: { "X-Access-Token": tk.Token }, signal: AbortSignal.timeout(25000) });
      return { status: res.status, body: (await res.text()).slice(0, 3000) };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  };

  await sleep(8000);
  out.probeHtml = await get("/probe.html");
  out.cdpVersion = await get("/cdp/json/version");
  out.cdpJson = await get("/cdp/json/list");

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});