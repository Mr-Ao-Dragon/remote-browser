import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionManager } from "../../session/manager.js";
import { json, registerTool } from "./shared.js";

type CloseArgs = Record<string, never>;

export function registerCloseTool(server: McpServer, manager: SessionManager): void {
  registerTool<CloseArgs>(
    server,
    manager,
    "browser_close",
    {
      title: "关闭浏览器",
      description: "立即释放本会话的远端浏览器实例。之后再次调用其它工具会重新创建一个干净的沙箱。",
      inputSchema: {},
    },
    async (_args, ctx) => {
      await manager.close(ctx.sessionKey);
      return json({ ok: true, closed: true });
    }
  );
}