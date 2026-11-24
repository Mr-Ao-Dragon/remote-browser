#!/usr/bin/env node
import { createAgsClient } from "./ags/client.js";
import { config } from "./config.js";
import { errorText, log } from "./logger.js";
import { runHttpServer } from "./mcp/http.js";
import { runStdioServer } from "./mcp/stdio.js";
import { SandboxRuntime } from "./sandbox/runtime.js";
import { ToolLease } from "./sandbox/tool-lease.js";
import { SessionManager } from "./session/manager.js";

function createShutdown(manager: SessionManager, tools: ToolLease): (reason: string) => Promise<void> {
  let shuttingDown = false;
  return async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { reason });
    // 先停实例，再按配置决定是否删除工具
    await manager.shutdown().catch((err) => log.error("shutdown failed", { error: errorText(err) }));
    await tools.dispose();
    process.exit(0);
  };
}

function installShutdownHandlers(shutdown: (reason: string) => Promise<void>): void {
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { error: errorText(err) });
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (err) => {
    log.error("unhandled rejection", { error: errorText(err) });
  });
}

function logStartup(): void {
  log.info("remote-browser starting", {
    region: config.region,
    transport: config.transport,
    toolMode: config.toolId ? "fixed" : "lazy",
    toolIdleMs: config.toolIdleMs,
    deleteToolOnExit: config.toolDeleteOnExit,
    sandboxPort: config.sandboxPort,
    idleMs: config.idleMs,
    idleAction: config.idleAction,
    instanceTimeout: config.instanceTimeout,
    maxSessions: config.maxSessions,
  });
}

async function main(): Promise<void> {
  const client = await createAgsClient();

  // 工具按需创建：启动阶段不碰控制面配额。
  let manager: SessionManager | undefined;
  const tools = new ToolLease(client, async () => {
    if (!manager) return false;
    await manager.stopIdlePaused(config.toolIdleMs);
    return !manager.hasLiveSessions();
  });
  manager = new SessionManager(new SandboxRuntime(client, tools));

  const shutdown = createShutdown(manager, tools);
  manager.start();
  tools.start();
  installShutdownHandlers(shutdown);
  logStartup();

  if (config.transport === "HTTP") {
    await runHttpServer(manager);
  } else {
    await runStdioServer(manager, () => void shutdown("stdio closed"));
  }
}

main().catch((err) => {
  log.error("fatal", { error: errorText(err) });
  process.exit(1);
});