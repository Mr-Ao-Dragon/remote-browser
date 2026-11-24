import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RbError } from "../../errors.js";
import { errorText, log } from "../../logger.js";
import type { SessionManager } from "../../session/manager.js";
import { json, registerTool, requireHttpUrl, summarize } from "./shared.js";

const NAVIGATION_TIMEOUT_MS = 45_000;

interface NavigateArgs {
  url: string;
  persistState?: boolean;
}

export function registerNavigateTool(server: McpServer, manager: SessionManager): void {
  registerTool<NavigateArgs>(
    server,
    manager,
    "browser_navigate",
    {
      title: "打开网页",
      description:
        "在远端浏览器中打开一个 http/https 页面，返回标题与最终地址。persistState=true 表示任务需要保留登录态/表单等状态，空闲时只暂停不销毁。",
      inputSchema: {
        url: z.string().describe("要打开的完整地址"),
        persistState: z.boolean().optional().describe("是否保留会话状态，默认 false"),
      },
    },
    async (args, ctx) =>
      ctx.run({ persistState: args.persistState }, async (page) => {
        const target = requireHttpUrl(args.url);
        const startedAt = Date.now();
        let status: number | null = null;

        try {
          const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
          status = response?.status() ?? null;
        } catch (err) {
          const message = errorText(err);
          const current = page.url();
          // 超时但页面已经落地时保留现场，让 Agent 自己决定是否继续等
          if (!/timeout/i.test(message) || !current || current === "about:blank") {
            throw new RbError("navigation_failed", `导航失败：${message.split("\n")[0].slice(0, 160)}`);
          }
          log.warn("navigation timed out, keeping current page state");
        }

        await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
        return json({ ok: true, ...(await summarize(page)), status, tookMs: Date.now() - startedAt });
      })
  );
}