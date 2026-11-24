/**
 * 探针 00：连通性 / 权限 / 配额 / 存量资源
 * 只做只读调用，不创建任何资源。
 * 凭证从 CSV 读取，仅在内存中使用，不打印、不落盘。
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
  const idIdx = header.findIndex((h) => /secretid/i.test(h));
  const keyIdx = header.findIndex((h) => /secretkey/i.test(h));
  if (idIdx < 0 || keyIdx < 0) throw new Error("credential csv header not recognized");
  return { secretId: row[idIdx], secretKey: row[keyIdx] };
}

function makeClient(region, cred) {
  const Client = tc.ags.v20250920.Client;
  return new Client({
    credential: { secretId: cred.secretId, secretKey: cred.secretKey },
    region,
    profile: {
      httpProfile: { endpoint: "ags.tencentcloudapi.com", reqTimeout: 30 },
    },
  });
}

function errInfo(e) {
  return { code: e && e.code ? e.code : "UNKNOWN", message: e && e.message ? e.message : String(e) };
}

async function probeRegion(region, cred) {
  const client = makeClient(region, cred);
  const out = { region };

  try {
    const r = await client.DescribeSandboxToolList({ Limit: 100 });
    out.tools = {
      total: r.TotalCount,
      items: (r.SandboxToolSet || []).map((t) => ({
        toolId: t.ToolId,
        toolName: t.ToolName,
        toolType: t.ToolType,
        status: t.Status,
        persistent: t.Persistent,
      })),
    };
  } catch (e) {
    out.toolsError = errInfo(e);
  }

  try {
    const r = await client.DescribeDeploymentList({ Limit: 200 });
    out.deployments = {
      total: r.TotalCount,
      items: (r.DeploymentSet || []).map((d) => ({
        deploymentId: d.DeploymentId,
        deploymentName: d.DeploymentName,
        toolId: d.ToolId,
        status: d.Status,
        scaling: d.ScalingConfiguration,
        lifecycle: d.LifecycleConfiguration,
        affinity: d.AffinityConfiguration,
      })),
    };
  } catch (e) {
    out.deploymentsError = errInfo(e);
  }

  try {
    const r = await client.DescribeSandboxInstanceList({ Limit: 100 });
    out.instances = {
      total: r.TotalCount,
      items: (r.InstanceSet || []).map((i) => ({
        instanceId: i.InstanceId,
        toolId: i.ToolId,
        toolName: i.ToolName,
        status: i.Status,
        persistent: i.Persistent,
        expiresAt: i.ExpiresAt,
      })),
    };
  } catch (e) {
    out.instancesError = errInfo(e);
  }

  try {
    const r = await client.DescribeQuotaOverview({});
    out.quota = r.AccountQuotaOverview || { note: "no AccountQuotaOverview", keys: Object.keys(r) };
  } catch (e) {
    out.quotaError = errInfo(e);
  }

  return out;
}

(async () => {
  const cred = loadCreds();
  const regions = (process.env.TC_REGIONS || "ap-shanghai,ap-hongkong")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const results = [];
  for (const region of regions) {
    results.push(await probeRegion(region, cred));
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: errInfo(e) }));
  process.exit(1);
});