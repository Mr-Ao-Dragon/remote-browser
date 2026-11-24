/**
 * 探针 21：清理本轮探针产生的不可用沙箱工具（释放配额）
 * 只删除明确属于本次探针且不可用/参数错误的工具。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const IDS = (process.env.TC_DELETE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

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
  profile: { httpProfile: { endpoint: "ags.tencentcloudapi.com", reqTimeout: 30 } },
});

const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: String(e?.message || e).slice(0, 200) });

(async () => {
  const out = [];
  for (const ToolId of IDS) {
    try {
      await client.DeleteSandboxTool({ ToolId });
      out.push({ ToolId, ok: true });
    } catch (e) {
      out.push({ ToolId, ok: false, error: errInfo(e) });
    }
  }
  const q = await client.DescribeQuotaOverview({});
  out.push({ quotaUsage: q.AccountQuotaOverview && q.AccountQuotaOverview.Usage });
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});