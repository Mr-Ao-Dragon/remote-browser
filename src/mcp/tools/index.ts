import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../../session/manager.js";
import { registerClickTool } from "./click.js";
import { registerCloseTool } from "./close.js";
import { registerExtractTool } from "./extract.js";
import { registerNavigateTool } from "./navigate.js";
import { registerScreenshotTool } from "./screenshot.js";
import { registerTypeTool } from "./type-text.js";
import { registerWaitTool } from "./wait.js";

/** 工具面固定为 7 个，不多不少。 */
export function registerBrowserTools(server: McpServer, manager: SessionManager): void {
  registerNavigateTool(server, manager);
  registerClickTool(server, manager);
  registerTypeTool(server, manager);
  registerScreenshotTool(server, manager);
  registerExtractTool(server, manager);
  registerWaitTool(server, manager);
  registerCloseTool(server, manager);
}