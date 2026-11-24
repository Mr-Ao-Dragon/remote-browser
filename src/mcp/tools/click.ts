import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RbError } from "../../errors.js";
import { errorText } from "../../logger.js";
import type { SessionManager } from "../../session/manager.js";
import { json, registerTool, requireSelector, summarize } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 15_000;

interface ClickArgs {
  selector: string;
  timeoutMs?: number;
}

export function registerClickTool(server: McpServer, manager: SessionManager): void {
  registerTool<ClickArgs>(
    server,
    manager,
    "browser_click",
    {
      title: "点击元素",
      description: "点击页面上第一个匹配 selector 的元素，点击后等待页面稳定，返回当前地址与标题。",
      inputSchema: {
        selector: z.string().describe("CSS 选择器"),
        timeoutMs: z.number().int().min(1000).max(60_000).optional().describe("等待元素出现的最长时间，默认 15s"),
      },
    },
    async (args, ctx) =>
      ctx.run({}, async (page) => {
        const selector = requireSelector(args.selector);
        const timeout = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        if ((await page.locator(selector).count().catch(() => 0)) === 0) {
          throw new RbError("selector_timeout", "未找到匹配的元素");
        }
        try {
          await page.locator(selector).first().click({ timeout });
        } catch (err) {
          throw new RbError("selector_timeout", `点击失败：${errorText(err).split("\n")[0].slice(0, 160)}`);
        }

        await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
        return json({ ok: true, ...(await summarize(page)) });
      })
  );
}