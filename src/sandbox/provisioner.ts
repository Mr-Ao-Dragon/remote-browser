import type { AgsClient } from "../ags/client.js";
import { config } from "../config.js";
import { errorCode, isNotFoundError, RbError } from "../errors.js";
import { log } from "../logger.js";
import { BROWSER_BOOTSTRAP } from "./bootstrap.js";

export interface SandboxTool {
  id: string;
  name: string;
  status: string;
  /** 由本进程创建，回收时才可以删除；复用已有工具时为 false。 */
  owned: boolean;
}

/** 非终态实例，用于判断工具是否仍被占用。 */
const LIVE_STATES = new Set(["CREATING", "RUNNING", "PAUSING", "PAUSED", "RESUMING"]);

const TOOL_READY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function customConfiguration() {
  return {
    Image: "ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest",
    ImageRegistryType: "custom",
    Command: ["/init"],
    Args: ["/bin/sh", "-c", BROWSER_BOOTSTRAP],
    Ports: [{ Name: "web", Port: config.sandboxPort, Protocol: "TCP" }],
    Resources: { CPU: "2", Memory: "4Gi" },
    Probe: {
      HttpGet: { Path: "/", Port: config.sandboxPort, Scheme: "HTTP" },
      ReadyTimeoutMs: 30_000,
      ProbeTimeoutMs: 3_000,
      ProbePeriodMs: 2_000,
      SuccessThreshold: 1,
      FailureThreshold: 10,
    },
  };
}

async function listTools(client: AgsClient): Promise<SandboxTool[]> {
  const res = (await client.DescribeSandboxToolList({ Limit: 100 })) as {
    SandboxToolSet?: Array<{ ToolId?: string; ToolName?: string; Status?: string; StatusReason?: string }>;
  };
  return (res.SandboxToolSet || []).map((tool) => ({
    id: tool.ToolId || "",
    name: tool.ToolName || "",
    status: tool.Status || "UNKNOWN",
    statusReason: tool.StatusReason,
    owned: false,
  }));
}

function assertUsable(tool: SandboxTool & { statusReason?: string }): SandboxTool {
  if (tool.status === "FAILED") {
    throw new RbError("tool_unavailable", `沙箱工具 ${tool.name || tool.id} 创建失败：${tool.statusReason || "未知原因"}`);
  }
  if (tool.status !== "ACTIVE") {
    throw new RbError("tool_unavailable", `沙箱工具 ${tool.name || tool.id} 当前状态为 ${tool.status}，暂不可用`);
  }
  return tool;
}

/** 工具处于 CREATING 时等它落定，避免在初始化窗口内被误判为不可用。 */
async function waitUsable(client: AgsClient, initial: SandboxTool): Promise<SandboxTool> {
  if (initial.status === "ACTIVE") return initial;
  if (initial.status === "FAILED") return assertUsable(initial);

  const deadline = Date.now() + TOOL_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tool = (await listTools(client)).find((item) => item.id === initial.id);
    if (!tool) throw new RbError("tool_unavailable", "沙箱工具已不存在或无权访问");
    if (tool.status === "ACTIVE") return tool;
    if (tool.status === "FAILED") return assertUsable(tool);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new RbError("tool_unavailable", `等待沙箱工具就绪超时（${TOOL_READY_TIMEOUT_MS / 1000}s）`);
}

/**
 * 定位或创建沙箱工具：
 * 1. 指定了 RB_TOOL_ID 时只校验它；
 * 2. 否则按 RB_TOOL_NAME 复用；
 * 3. 都没有时创建（受 RB_MAX_TOOLS 保护）。
 */
export async function ensureSandboxTool(client: AgsClient): Promise<SandboxTool> {
  const tools = await listTools(client);

  if (config.toolId) {
    const tool = tools.find((item) => item.id === config.toolId);
    if (!tool) throw new RbError("tool_unavailable", "指定的沙箱工具不存在或无权访问，请检查 RB_TOOL_ID");
    return waitUsable(client, tool);
  }

  const existing = tools.find((item) => item.name === config.toolName);
  if (existing) return waitUsable(client, existing);

  if (tools.length >= config.maxTools) {
    throw new RbError("quota_exceeded", `沙箱工具数量已达上限（${tools.length}/${config.maxTools}），无法自动创建`);
  }

  log.info("creating sandbox tool", { name: config.toolName });
  const created = (await client.CreateSandboxTool({
    ToolName: config.toolName,
    ToolType: "custom",
    Description: "remote-browser: ephemeral chromium sandbox (CDP on 9000/cdp)",
    NetworkConfiguration: { NetworkMode: "PUBLIC" },
    DefaultTimeout: config.toolTimeout,
    Persistent: false,
    CustomConfiguration: customConfiguration(),
  })) as { ToolId?: string };
  if (!created.ToolId) throw new RbError("sandbox_error", "创建沙箱工具未返回 ToolId");

  const toolId = created.ToolId;
  const deadline = Date.now() + TOOL_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tool = (await listTools(client)).find((item) => item.id === toolId);
    // 创建中会短暂处于 CREATING，必须等它变成 ACTIVE 才能起实例
    if (tool?.status === "ACTIVE") return { ...tool, owned: true };
    if (tool?.status === "FAILED") assertUsable(tool);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new RbError("tool_unavailable", `等待沙箱工具就绪超时（${TOOL_READY_TIMEOUT_MS / 1000}s）`);
}

/** 工具下是否还有非终态实例（含创建中/暂停中），用于回收前的安全检查。 */
export async function countLiveInstances(client: AgsClient, toolId: string): Promise<number> {
  const res = (await client.DescribeSandboxInstanceList({ ToolId: toolId, Limit: 100 })) as {
    InstanceSet?: Array<{ Status?: string }>;
  };
  return (res.InstanceSet || []).filter((item) => LIVE_STATES.has(item.Status || "")).length;
}

/** 删除工具。幂等：已不存在或正在删除都视为成功。 */
export async function deleteSandboxTool(client: AgsClient, toolId: string): Promise<void> {
  await client.DeleteSandboxTool({ ToolId: toolId }).catch((err) => {
    if (isNotFoundError(err)) return;
    if (/Deleting|InvalidStatus|not exist/i.test(`${errorCode(err)} ${(err as Error)?.message || ""}`)) return;
    throw err;
  });
}