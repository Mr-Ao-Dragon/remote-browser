/**
 * DeepSeek Harness (dsh) 适配层。
 *
 * 这里不实现任何浏览器能力，只做四件事：
 *   1. 找到本仓库构建出的 MCP Server（dist/index.js）；
 *   2. 把 TC_* / RB_* 显式转发给子进程（dsh-mcp-client 会清洗父进程里的凭证型变量）；
 *   3. 从 dsh 凭证库读取设置页写入的配置项，作为最低优先级的一层注入子进程环境；
 *   4. 挂载 dsh 自带的 @deepseek-ai/dsh-mcp-client，把 7 个 MCP 工具注册为原生工具
 *      （公开名形如 mcp__remote_browser__browser_navigate）。
 *
 * 因此核心代码与 dsh 完全解耦：其它 Agent 工具继续直接接 MCP Server 即可。
 *
 * 设置界面见 ./client.js（同一个包的浏览器半边）。dsh 只对第三方插件开放
 * `credentials.describe/set/unset` 这个通用可写通道，所以设置页里的所有字段
 * 都落在凭证库里（引用名就是环境变量名），与进程环境变量共用同一套命名。
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Cordis 插件标识，用于加载诊断。 */
export const name = "remote-browser";
/** 依赖的工具注册表就绪后才执行 apply。 */
export const inject = ["tools"];

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库内默认入口：integrations/deepseek-harness/index.js -> ../../dist/index.js */
const REPO_DIST_ENTRY = resolve(HERE, "../../dist/index.js");

const DEFAULT_SERVER_NAME = "remote_browser";
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** 首次导航包含建工具 + 起实例，远超过 MCP 客户端默认的 60s。 */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 240_000;

/** 只转发本服务真正读取的前缀，避免把无关凭证带进子进程。 */
const FORWARDED_ENV_PREFIXES = ["TC_", "RB_"];

/** 子进程必须讲 stdio，否则 mcp-client 无法完成握手。 */
const FORCED_ENV = { RB_TRANSPORT: "STDIO" };

/** dsh 是长驻进程，默认让按需回收在无人使用时生效。 */
const DEFAULT_ENV = {
  RB_TOOL_DELETE_ON_EXIT: "1",
  RB_TOOL_IDLE_MS: "600000",
};

/**
 * 设置页维护的配置项（凭证库里的引用名 = 环境变量名）。
 * 前两项是密钥，其余是可以在界面上改的运行参数。
 * 顺序即界面顺序；client.js 里有一份同样的清单。
 */
export const CREDENTIAL_REFS = Object.freeze([
  "TC_SECRET_ID",
  "TC_SECRET_KEY",
  "TC_REGION",
  "RB_IDLE_MS",
  "RB_IDLE_ACTION",
  "RB_MAX_SESSIONS",
  "RB_TOOL_IDLE_MS",
  "RB_LOG_LEVEL",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * 解析 MCP Server 入口，优先级：config.entry > RB_MCP_ENTRY > 仓库内 dist/index.js。
 * @param {{ entry?: string }} [config]
 * @returns {string} 入口绝对路径
 */
export function resolveEntry(config = {}) {
  const candidate = nonEmptyString(config.entry) || nonEmptyString(process.env.RB_MCP_ENTRY) || REPO_DIST_ENTRY;
  if (!isAbsolute(candidate)) {
    throw new Error(`remote-browser(dsh): entry 必须是绝对路径，收到 "${candidate}"`);
  }
  if (!existsSync(candidate)) {
    throw new Error(
      `remote-browser(dsh): 找不到 MCP Server 入口 ${candidate}。` +
        ' 先在仓库根目录执行 "npm run build"，或用 RB_MCP_ENTRY / config.entry 指定入口。'
    );
  }
  return candidate;
}

/**
 * 从 dsh 凭证库读出设置页维护的配置项。
 * 只读引用，不缓存；读取失败按未设置处理，不影响插件启动。
 * @param {{ get?: (name: string) => unknown }} ctx
 * @returns {Promise<Record<string, string>>}
 */
export async function readCredentialEnv(ctx) {
  const credentials = typeof ctx?.get === "function" ? ctx.get("credentials") : undefined;
  if (!credentials || typeof credentials.resolve !== "function") return {};
  const env = {};
  for (const ref of CREDENTIAL_REFS) {
    try {
      const resolved = await credentials.resolve(ref);
      if (resolved && typeof resolved.value === "string" && resolved.value.trim() !== "") {
        env[ref] = resolved.value;
      }
    } catch {
      // 单个引用解析失败（提供方抖动等）不应拖垮启动，按未配置处理。
    }
  }
  return env;
}

/**
 * 组装子进程环境变量。
 * dsh-mcp-client 会丢弃父进程中"看起来像凭证"的变量与所有 DSH_*，所以必须显式转发。
 * 优先级：内置默认值 < 凭证库（设置页） < 进程环境变量 < 插件 config.env < 强制项。
 * @param {{ env?: Record<string, string | undefined> }} [config]
 * @param {Record<string, string>} [credentialEnv] - readCredentialEnv 的结果
 * @returns {Record<string, string>}
 */
export function collectEnv(config = {}, credentialEnv = {}) {
  const env = { ...DEFAULT_ENV };
  for (const [key, value] of Object.entries(credentialEnv ?? {})) {
    if (typeof value !== "string" || value === "") continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (FORWARDED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    env[key] = String(value);
  }
  Object.assign(env, FORCED_ENV);
  return env;
}

/**
 * 生成传给 @deepseek-ai/dsh-mcp-client 的配置。
 * @param {{
 *   entry?: string,
 *   serverName?: string,
 *   command?: string,
 *   cwd?: string,
 *   env?: Record<string, string | undefined>,
 *   toolCallTimeoutMs?: number,
 *   failOnStartupError?: boolean,
 * }} [config]
 * @param {Record<string, string>} [credentialEnv] - 凭证库提供的配置项
 */
export function buildClientConfig(config = {}, credentialEnv = {}) {
  const serverName = nonEmptyString(config.serverName) || DEFAULT_SERVER_NAME;
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(
      `remote-browser(dsh): serverName 必须匹配 ${SERVER_NAME_PATTERN}，收到 "${serverName}"`
    );
  }
  const entry = resolveEntry(config);
  const env = collectEnv(config, credentialEnv);
  const timeout = config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(`remote-browser(dsh): toolCallTimeoutMs 必须是正整数，收到 ${String(timeout)}`);
  }

  // Electron 里 process.execPath 不是 node；显式让子进程以 Node 模式运行。
  if (process.versions.electron && env.ELECTRON_RUN_AS_NODE === undefined) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  return {
    transport: "stdio",
    serverName,
    command: nonEmptyString(config.command) || process.execPath,
    args: [entry],
    env,
    cwd: nonEmptyString(config.cwd) || dirname(dirname(entry)),
    toolCallTimeoutMs: timeout,
    failOnStartupError: config.failOnStartupError ?? false,
  };
}

/** 设置页连点时合并成一次重启。 */
const RESTART_DEBOUNCE_MS = 300;

/**
 * Cordis 插件入口：把 MCP Server 挂到工具表上。
 * 设置页改了配置后，用 fiber.update() 让子进程带着新环境变量重新连接。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Parameters<typeof buildClientConfig>[0]} [config]
 */
export async function apply(ctx, config = {}) {
  const mcpClient = await import("@deepseek-ai/dsh-mcp-client");
  const initialEnv = await readCredentialEnv(ctx);
  // 子插件随本插件卸载，工具一并注销。
  const fiber = await ctx.plugin(mcpClient, buildClientConfig(config, initialEnv));

  if (typeof ctx.get !== "function" || typeof ctx.on !== "function" || typeof ctx.effect !== "function") {
    return;
  }
  if (!ctx.get("credentials")) return;

  let appliedEnv = JSON.stringify(collectEnv(config, initialEnv));
  let timer;
  ctx.effect(() => {
    const off = ctx.on("credentials/updated", (ref) => {
      if (!CREDENTIAL_REFS.includes(String(ref))) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(async () => {
        timer = undefined;
        try {
          const nextConfig = buildClientConfig(config, await readCredentialEnv(ctx));
          const nextEnv = JSON.stringify(nextConfig.env);
          if (nextEnv === appliedEnv) return; // 环境变量层覆盖了凭证库，重连也没意义
          appliedEnv = nextEnv;
          await fiber.update(nextConfig);
          ctx.logger.info("remote-browser(dsh): 设置已变化，MCP 子进程已重连");
        } catch (error) {
          ctx.logger.error(
            `remote-browser(dsh): 应用新设置失败：${error instanceof Error ? error.message : String(error)}`
          );
        }
      }, RESTART_DEBOUNCE_MS);
    });
    return () => {
      off?.();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, "remote-browser.settings-watch");
}