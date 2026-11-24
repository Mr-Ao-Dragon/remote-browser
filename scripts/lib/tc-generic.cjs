/**
 * 通用腾讯云 API 客户端（无额外依赖）
 * 复用 tencentcloud-sdk-nodejs-common 的抽象 Client，可按需调用任意云 API。
 * 凭证从 CSV 读取，仅内存使用，不打印。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AbstractClient } = require("tencentcloud-sdk-nodejs-common");

function loadCreds() {
  const p =
    process.env.TC_CRED_FILE ||
    path.join(os.homedir(), "Downloads", "SecretKey (1).csv");
  const lines = fs.readFileSync(p, "utf8").trim().split(/\r?\n/);
  const header = lines[0].split(",").map((s) => s.trim());
  const row = lines[1].split(",").map((s) => s.trim());
  const secretId = row[header.findIndex((h) => /secretid/i.test(h))];
  const secretKey = row[header.findIndex((h) => /secretkey/i.test(h))];
  if (!secretId || !secretKey) throw new Error("credential csv not recognized");
  return { secretId, secretKey };
}

function makeClient(service, version, region, cred) {
  return new AbstractClient(`${service}.tencentcloudapi.com`, version, {
    credential: cred || loadCreds(),
    region: region || "ap-shanghai",
    profile: {
      httpProfile: { reqTimeout: 30 },
      // 关掉 SDK 的默认错误日志，避免把请求细节打到 stdout
      signMethod: "TC3-HMAC-SHA256",
    },
  });
}

module.exports = { loadCreds, makeClient };