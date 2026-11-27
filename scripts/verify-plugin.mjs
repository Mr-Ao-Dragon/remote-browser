/**
 * 校验插件包：Manifest 结构、路径占位符、Skill 同步状态、以及真实 MCP 握手。
 *
 * 不访问腾讯云：只做 initialize + tools/list。
 * 运行：npm run plugin:check
 */

import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "remote-browser");
const EXPECTED_TOOLS = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_extract",
  "browser_wait",
  "browser_close",
].sort();

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function listTree(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".writing") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listTree(path.join(dir, entry.name), rel)));
    else files.push(rel);
  }
  return files.sort();
}

function checkManifest(manifest, label) {
  assert.equal(manifest["$schema"], "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", `${label}: $schema`);
  assert.equal(manifest.name, "remote-browser", `${label}: name`);
  assert.match(manifest.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/, `${label}: name 不符合 schema`);
  for (const key of Object.keys(manifest)) {
    assert.ok(
      ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"].includes(key),
      `${label}: 未知顶层字段 ${key}`
    );
  }
  if (manifest.author) {
    for (const key of Object.keys(manifest.author)) {
      assert.ok(["name", "email", "url"].includes(key), `${label}: author 未知字段 ${key}`);
    }
  }
}

function checkPortableMcp(mcp, label) {
  assert.deepEqual(Object.keys(mcp).sort(), ["$schema", "mcpServers"], `${label}: 顶层字段只能是 $schema + mcpServers`);
  assert.equal(mcp["$schema"], "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", `${label}: $schema`);
  const server = mcp.mcpServers["remote-browser"];
  assert.ok(server, `${label}: 缺少 remote-browser 条目`);
  for (const key of Object.keys(server)) {
    assert.ok(["type", "command", "args", "env", "cwd"].includes(key), `${label}: 未知字段 ${key}`);
  }
  assert.equal(server.type, "stdio", `${label}: type 必须是 stdio`);
  assert.equal(server.command, "node", `${label}: command`);
  assert.ok(Array.isArray(server.args) && server.args.length > 0, `${label}: args 必须是非空数组`);
  assert.ok(
    server.args.some((arg) => arg.includes("${PLUGIN_ROOT}/server/dist/remote-browser.cjs")),
    `${label}: args 必须用 \${PLUGIN_ROOT} 定位 bundle`
  );
  if (server.env) {
    for (const key of Object.keys(server.env)) {
      assert.ok(!["PLUGIN_ROOT", "PLUGIN_DATA"].includes(key), `${label}: 不能覆盖保留变量 ${key}`);
    }
  }
  if (server.cwd) {
    assert.match(server.cwd, /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/, `${label}: cwd 必须是插件相对路径`);
  }
}

function checkClaudeMcp(mcp, label) {
  const server = mcp.mcpServers["remote-browser"];
  assert.ok(server, `${label}: 缺少 remote-browser 条目`);
  assert.equal(server.command, "node", `${label}: command`);
  assert.ok(
    server.args.some((arg) => arg.includes("${CLAUDE_PLUGIN_ROOT}/server/dist/remote-browser.cjs")),
    `${label}: args 必须用 \${CLAUDE_PLUGIN_ROOT} 定位 bundle`
  );
  const referenced = new Set();
  for (const value of Object.values(server.env ?? {})) {
    for (const match of String(value).matchAll(/\$\{user_config\.([a-z0-9_]+)\}/g)) {
      referenced.add(match[1]);
    }
  }
  return referenced;
}

async function checkSkillSynced() {
  const from = path.join(root, "skills", "remote-browser");
  const to = path.join(pluginDir, "skills", "remote-browser");
  const sourceFiles = await listTree(from);
  const packagedFiles = await listTree(to);
  assert.deepEqual(packagedFiles, sourceFiles, "插件内 skills 与仓库 skills 文件列表不一致");
  for (const rel of sourceFiles) {
    const a = await readFile(path.join(from, rel));
    const b = await readFile(path.join(to, rel));
    assert.ok(a.equals(b), `插件内 skills/${rel} 与仓库版本不一致，请运行 npm run plugin:build`);
  }
}

async function checkSmoke() {
  const bundleFile = path.join(pluginDir, "server", "dist", "remote-browser.cjs");
  const info = await stat(bundleFile);
  assert.ok(info.size > 100_000, "server bundle 不存在或过小，请运行 npm run plugin:build");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundleFile],
    cwd: pluginDir,
    env: { ...process.env, RB_TRANSPORT: "STDIO", RB_LOG_LEVEL: "ERROR" },
  });
  const client = new Client({ name: "plugin-check", version: "0.0.0" }, { capabilities: {} });
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error("MCP 握手超时")), 30_000));
  try {
    await Promise.race([client.connect(transport), timer]);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, EXPECTED_TOOLS, `工具面不一致：${names.join(", ")}`);

    const wait = tools.find((tool) => tool.name === "browser_wait");
    assert.ok(
      String(wait.description).includes("全部满足"),
      "browser_wait 的描述未包含修正后的语义，请运行 npm run plugin:build"
    );

    const serialized = JSON.stringify(tools);
    for (const forbidden of ["instanceId", "sessionId", "toolId", "deploymentId"]) {
      assert.ok(!serialized.includes(forbidden), `工具 schema 泄露了 ${forbidden}`);
    }
    return tools.length;
  } finally {
    await client.close().catch(() => undefined);
    transport.close().catch(() => undefined);
  }
}

const portable = await readJson(path.join(pluginDir, "plugin.json"));
checkManifest(portable, "plugin.json");
checkPortableMcp(await readJson(path.join(pluginDir, "mcp.json")), "mcp.json");

const claudeManifest = await readJson(path.join(pluginDir, ".claude-plugin", "plugin.json"));
assert.equal(claudeManifest.name, "remote-browser", ".claude-plugin/plugin.json: name");
assert.ok(claudeManifest.version && claudeManifest.description, ".claude-plugin/plugin.json: 缺少 version/description");
const claudeMcp = await readJson(path.join(pluginDir, ".mcp.json"));
const referenced = checkClaudeMcp(claudeMcp, ".mcp.json");
for (const key of referenced) {
  assert.ok(claudeManifest.userConfig?.[key], `.mcp.json 引用了未声明的 userConfig.${key}`);
}

const codexMarket = await readJson(path.join(root, ".agents", "plugins", "marketplace.json"));
assert.ok(codexMarket.name && Array.isArray(codexMarket.plugins), ".agents/plugins/marketplace.json 结构不完整");
for (const entry of codexMarket.plugins) {
  assert.ok(entry.policy?.installation && entry.policy?.authentication, `marketplace 条目 ${entry.name} 缺少 policy`);
  assert.ok(entry.category, `marketplace 条目 ${entry.name} 缺少 category`);
  assert.ok(entry.source?.path?.startsWith("./"), `marketplace 条目 ${entry.name} 的 source.path 必须以 ./ 开头`);
}

const claudeMarket = await readJson(path.join(root, ".claude-plugin", "marketplace.json"));
assert.ok(claudeMarket.name && claudeMarket.owner?.name, ".claude-plugin/marketplace.json 缺少 name/owner");

await checkSkillSynced();
const toolCount = await checkSmoke();

console.log("plugin check:");
console.log(`  manifests             ok`);
console.log(`  skills synced         ok`);
console.log(`  mcp handshake         ok (${toolCount} tools)`);