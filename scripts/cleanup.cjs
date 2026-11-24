#!/usr/bin/env node
/**
 * 清理遗留沙箱实例（默认只列出，不执行任何写操作）。
 *
 *   node scripts/cleanup.cjs                     # 列出 RUNNING / PAUSED 实例
 *   node scripts/cleanup.cjs --tool sdt-xxx      # 只看某个工具
 *   node scripts/cleanup.cjs --stop --yes        # 真正停止（不可回滚）
 *   node scripts/cleanup.cjs --tools             # 列出所有沙箱工具
 *   node scripts/cleanup.cjs --delete-tool sdt-xxx --yes   # 删除工具（仍有活跃实例时拒绝）
 *   node scripts/cleanup.cjs --delete-tool sdt-xxx --yes --force  # 连实例一起删
 *
 * 停止与删除都不可回滚：端口与 Token 立即失效。加 --yes 才会执行。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ags } = require("tencentcloud-sdk-nodejs-ags");

const REGION = process.env.TC_REGION || "ap-shanghai";
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const TOOL = valueOf("--tool", "");
const DO_STOP = has("--stop");
const LIST_TOOLS = has("--tools");
const DELETE_TOOL = valueOf("--delete-tool", "");
const CONFIRMED = has("--yes");
const FORCE = has("--force");

const LIVE_STATES = ["CREATING", "RUNNING", "PAUSING", "PAUSED", "RESUMING"];

async function deleteTool(client, toolId) {
  const res = await client.DescribeSandboxInstanceList({ ToolId: toolId, Limit: 100 });
  const live = (res.InstanceSet || []).filter((i) => LIVE_STATES.includes(i.Status));
  if (live.length > 0 && !FORCE) {
    console.log(`工具 ${toolId} 下仍有 ${live.length} 个活跃实例，已拒绝删除。请先 --stop --yes。`);
    process.exit(3);
  }
  if (!CONFIRMED) {
    console.log(`将删除工具 ${toolId}（不可回滚）。确认请加 --yes。`);
    process.exit(2);
  }
  if (live.length > 0) {
    for (const i of live) {
      await client.StopSandboxInstance({ InstanceId: i.InstanceId }).catch(() => undefined);
    }
    console.log(`已请求停止 ${live.length} 个实例`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  await client.DeleteSandboxTool({ ToolId: toolId });
  console.log(`已提交删除工具 ${toolId}`);
}

function readCredentialFile(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",").map((s) => s.trim());
  const row = lines[1].split(",").map((s) => s.trim());
  return {
    secretId: row[header.findIndex((h) => /secretid/i.test(h))],
    secretKey: row[header.findIndex((h) => /secretkey/i.test(h))],
  };
}

(async () => {
  const credential =
    process.env.TC_SECRET_ID && process.env.TC_SECRET_KEY
      ? { secretId: process.env.TC_SECRET_ID, secretKey: process.env.TC_SECRET_KEY }
      : readCredentialFile(process.env.TC_CRED_FILE || path.join(os.homedir(), "Downloads", "SecretKey (1).csv"));

  const client = new ags.v20250920.Client({
    credential,
    region: REGION,
    profile: { httpProfile: { endpoint: "ags.tencentcloudapi.com", reqTimeout: 60 }, signMethod: "TC3-HMAC-SHA256" },
  });

  if (LIST_TOOLS) {
    const list = await client.DescribeSandboxToolList({ Limit: 100 });
    const tools = (list.SandboxToolSet || []).map((t) => ({
      ToolId: t.ToolId,
      ToolName: t.ToolName,
      Status: t.Status,
      Persistent: t.Persistent,
    }));
    console.log(JSON.stringify(tools, null, 2));
    return;
  }

  if (DELETE_TOOL) {
    await deleteTool(client, DELETE_TOOL);
    return;
  }

  const res = await client.DescribeSandboxInstanceList({ Limit: 100 });
  const targets = (res.InstanceSet || []).filter(
    (i) => ["RUNNING", "PAUSED", "PAUSING"].includes(i.Status) && (!TOOL || i.ToolId === TOOL)
  );

  if (targets.length === 0) {
    console.log("没有处于 RUNNING / PAUSED 的实例");
    return;
  }

  console.log(`待处理 ${targets.length} 个实例：`);
  for (const i of targets) {
    const started = i.StartTime || i.CreateTime || "";
    console.log(`  ${i.ToolId}  ${i.Status.padEnd(8)}  ${i.InstanceId}${started ? `  ${started}` : ""}`);
  }

  if (!DO_STOP) {
    console.log("\n仅列出。要停止请加 --stop --yes（停止不可回滚）。");
    return;
  }
  if (!CONFIRMED) {
    console.log("\n已指定 --stop 但缺少 --yes，未执行。");
    process.exit(2);
  }

  let ok = 0;
  let failed = 0;
  for (const i of targets) {
    try {
      await client.StopSandboxInstance({ InstanceId: i.InstanceId });
      ok += 1;
    } catch (err) {
      const code = (err && err.code) || "";
      if (/ResourceNotFound|NotFound|does not exist/i.test(code + " " + ((err && err.message) || ""))) ok += 1;
      else {
        failed += 1;
        console.error(`  停止失败 ${i.InstanceId}：${code}`);
      }
    }
  }
  console.log(`\n已停止 ${ok} 个，失败 ${failed} 个`);
})().catch((err) => {
  console.error(`cleanup 失败：${(err && err.message) || err}`.slice(0, 300));
  process.exit(1);
});