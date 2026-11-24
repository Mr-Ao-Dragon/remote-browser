import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RbError } from "../../errors.js";
import { errorText } from "../../logger.js";
import type { SessionManager } from "../../session/manager.js";
import { json, registerTool, requireSelector } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 15_000;

interface TypeArgs {
  selector: string;
  text: string;
  timeoutMs?: number;
}

export function registerTypeTool(server: McpServer, manager: SessionManager): void {
  registerTool<TypeArgs>(
    server,
    manager,
    "browser_type",
    {
      title: "输入文本",
      description: "向第一个匹配 selector 的输入框填入文本（会先清空），返回输入后的值。",
      inputSchema: {
        selector: z.string().describe("输入框 CSS 选择器"),
        text: z.string().describe("要填入的文本"),
        timeoutMs: z.number().int().min(1000).max(60_000).optional().describe("等待输入框的最长时间，默认 15s"),
      },
    },
    async (args, ctx) =>
      ctx.run({}, async (page) => {
        const selector = requireSelector(args.selector);
        const timeout = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const field = page.locator(selector);

        if ((await field.count().catch(() => 0)) === 0) {
          throw new RbError("selector_timeout", "未找到匹配的输入框");
        }
        try {
          await field.first().fill(args.text, { timeout });
        } catch (err) {
          throw new RbError("selector_timeout", `输入失败：${errorText(err).split("\n")[0].slice(0, 160)}`);
        }

        const value = await field.first().inputValue().catch(() => null);
        return json({ ok: true, value });
      })
  );
}