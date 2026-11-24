/**
 * 探针 01b：查镜像仓库与预热镜像，评估 custom 工具可用的镜像来源。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";

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

const errInfo = (e) => ({ code: e?.code || "UNKNOWN", message: e?.message || String(e) });

(async () => {
  const out = { region: REGION };

  try {
    const r = await client.DescribeRegistryList({ Limit: 100 });
    out.registryList = r;
  } catch (e) {
    out.registryListError = errInfo(e);
  }

  try {
    const r = await client.DescribePreCacheImageList({ Limit: 100 });
    out.preCacheList = r;
  } catch (e) {
    out.preCacheListError = errInfo(e);
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: errInfo(e) }));
  process.exit(1);
});