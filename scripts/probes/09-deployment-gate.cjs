/**
 * 探针 09：确认 Deployment 对 SandboxTool 的硬性门槛
 *
 * 目标（P1 的前置校验）：
 *  1. 用「非持久 browser 工具」直接创建 Deployment，观察服务端是否拒绝。
 *  2. 查询预缓存镜像列表，看是否平台自带可用镜像。
 *
 * 只读 + 一次 CreateDeployment（失败即回滚）。不打印凭证。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

function loadCreds() {
  const p =
    process.env.TC_CRED_FILE ||
    path.join(os.homedir(), "Downloads", "SecretKey (1).csv");
  const lines = fs.readFileSync(p, "utf8").trim().split(/\r?\n/);
  const header = lines[0].split(",").map((s) => s.trim());
  const row = lines[1].split(",").map((s) => s.trim());
  return {
    secretId: row[header.findIndex((h) => /secretid/i.test(h))],
    secretKey: row[header.findIndex((h) => /secretkey/i.test(h))],
  };
}

function makeClient(region, cred) {
  const Client = tc.ags.v20250920.Client;
  return new Client({
    credential: { secretId: cred.secretId, secretKey: cred.secretKey },
    region,
    profile: {
      httpProfile: { endpoint: "ags.tencentcloudapi.com", reqTimeout: 40 },
    },
  });
}

function errInfo(e) {
  return {
    code: (e && e.code) || "UNKNOWN",
    message: (e && e.message) || String(e),
    requestId: (e && e.requestId) || undefined,
  };
}

async function main() {
  const region = process.env.TC_REGION || "ap-shanghai";
  const cred = loadCreds();
  const client = makeClient(region, cred);
  const report = { region };

  // 1) 当前工具清单
  try {
    const r = await client.DescribeSandboxToolList({ Limit: 100 });
    report.tools = (r.SandboxToolSet || []).map((t) => ({
      toolId: t.ToolId,
      toolName: t.ToolName,
      toolType: t.ToolType,
      status: t.Status,
      persistent: t.Persistent,
    }));
  } catch (e) {
    report.toolsError = errInfo(e);
  }

  // 2) 预缓存镜像
  try {
    const r = await client.DescribePreCacheImageList({ MaxResults: 100 });
    report.preCacheImages = {
      total: r.TotalCount,
      items: (r.ImageSet || r.PreCacheImageSet || []).map((i) => ({
        image: i.Image || i.ImageUrl,
        registryType: i.ImageRegistryType,
        status: i.Status,
      })),
    };
  } catch (e) {
    report.preCacheImagesError = errInfo(e);
  }

  // 3) 用非持久 browser 工具建 Deployment
  const toolId = process.env.TC_TOOL_ID || "sdt-b2pwk0dm";
  const dName = `rb-probe-dpl-${Date.now().toString(36)}`;
  try {
    const r = await client.CreateDeployment({
      DeploymentName: dName,
      ToolId: toolId,
      ScalingConfiguration: {
        MinInstanceCount: 0,
        MaxInstanceCount: 5,
        MaxInstanceRequestConcurrency: 1,
      },
      LifecycleConfiguration: { IdleTimeoutSeconds: 120, IdleAction: "STOP" },
    });
    report.createDeployment = { ok: true, deploymentId: r.DeploymentId, name: dName };
  } catch (e) {
    report.createDeployment = { ok: false, error: errInfo(e), name: dName, toolId };
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});