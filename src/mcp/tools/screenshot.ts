import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RbError } from "../../errors.js";
import type { SessionManager } from "../../session/manager.js";
import { registerTool, summarize } from "./shared.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface ScreenshotArgs {
  fullPage?: boolean;
}

export function registerScreenshotTool(server: McpServer, manager: SessionManager): void {
  registerTool<ScreenshotArgs>(
    server,
    manager,
    "browser_screenshot",
    {
      title: "页面截图",
      description: "对当前页面截图并返回 PNG 图片。fullPage=true 截取整页。",
      inputSchema: {
        fullPage: z.boolean().optional().describe("是否截取整页，默认 false"),
      },
    },
    async (args, ctx) =>
      ctx.run({}, async (page): Promise<CallToolResult> => {
        const fullPage = Boolean(args.fullPage);
        const image = await page.screenshot({ fullPage, type: "png" });
        if (image.length > MAX_IMAGE_BYTES) {
          throw new RbError("invalid_argument", "截图超过 8MB，请改用 fullPage=false 或缩小页面后重试");
        }

        const meta = { ok: true, bytes: image.length, fullPage, ...(await summarize(page)) };
        return {
          content: [
            { type: "image", data: image.toString("base64"), mimeType: "image/png" },
            { type: "text", text: JSON.stringify(meta) },
          ],
        };
      })
  );
}