/**
 * 探针 30：空闲 STOP 回收验证
 * 用法：node scripts/probes/30-idle-recycle.js [toolId] [waitSeconds]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const tc = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const TOOL = process.argv[2] || "sdt-gdf08rfu";
const WAIT = Number(process.argv[3] || 90);

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
const snap = async () =>
  ((await client.DescribeSandboxInstanceList({ Limit: 50 })).InstanceSet || [])
    .filter((i) => i.ToolId === TOOL)
    .map((i) => ({ id: i.InstanceId.slice(0, 8), status: i.Status, updated: i.UpdateTime || i.UpdatedAt }));

(async () => {
  const t0 = await snap();
  console.log(JSON.stringify({ phase: "start", at: new Date().toISOString(), tool: TOOL, instances: t0 }, null, 2));
  const startRunning = t0.filter((i) => i.status === "RUNNING").length;
  const tStart = Date.now();
  let last = t0;
  while (Date.now() - tStart < WAIT * 1000) {
    await sleep(15000);
    last = await snap();
    console.log(
      JSON.stringify({
        t: Math.round((Date.now() - tStart) / 1000),
        instances: last,
      })
    );
    if (last.filter((i) => i.status === "RUNNING").length === 0) break;
  }
  console.log(
    JSON.stringify(
      {
        result: {
          runningAtStart: startRunning,
          runningAtEnd: last.filter((i) => i.status === "RUNNING").length,
          elapsedSec: Math.round((Date.now() - tStart) / 1000),
        },
      },
      null,
      2
    )
  );
})().catch((e) => {
  console.error(JSON.stringify({ fatal: String(e?.message || e) }, null, 2));
  process.exit(1);
});