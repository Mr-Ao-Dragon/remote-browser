import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../session/manager.js";
import { registerBrowserTools } from "./tools/index.js";

const SERVER_INFO = { name: "remote-browser", version: "1.0.0" };

export const SERVER_INSTRUCTIONS =
  "远端浏览器工具：网页导航、点击、输入、截图、结构化提取与等待。无需关心沙箱生命周期，空闲会自动释放；需要保留登录态时给 browser_navigate 传 persistState=true。";

export function createMcpServer(manager: SessionManager): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerBrowserTools(server, manager);
  return server;
}