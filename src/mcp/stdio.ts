import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from "../logger.js";
import type { SessionManager } from "../session/manager.js";
import { createMcpServer } from "./server.js";

/**
 * 父进程关闭管道时回调，让调用方走统一的优雅退出流程。
 * SDK 的 StdioServerTransport 不监听 stdin 结束事件，这里自行监听。
 */
export async function runStdioServer(manager: SessionManager, onClose: () => void): Promise<void> {
  const server = createMcpServer(manager);
  await server.connect(new StdioServerTransport());
  process.stdin.on("end", onClose);
  process.stdin.on("close", onClose);
  log.info("MCP server ready", { transport: "stdio" });
}