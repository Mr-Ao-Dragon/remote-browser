import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RbError } from "../../errors.js";
import { errorText } from "../../logger.js";
import type { SessionManager } from "../../session/manager.js";
import { json, registerTool, summarize } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 15_000;

interface WaitArgs {
  selector?: string;
  text?: string;
  urlIncludes?: string;
  timeoutMs?: number;
}

export function registerWaitTool(server: McpServer, manager: SessionManager): void {
  registerTool<WaitArgs>(
    server,
    manager,
    "browser_wait",
    {
      title: "等待条件",
      description:
        "等待选择器出现 / 页面出现指定文本 / 地址包含指定片段。只传一个条件即可；同时传多个条件时需要全部满足才返回。",
      inputSchema: {
        selector: z.string().optional().describe("等待该选择器出现"),
        text: z.string().optional().describe("等待页面正文包含该文本"),
        urlIncludes: z.string().optional().describe("等待当前地址包含该片段"),
        timeoutMs: z.number().int().min(500).max(60_000).optional().describe("超时时间，默认 15s"),
      },
    },
    async (args, ctx) => {
      const { selector, text, urlIncludes } = args;
      if (!selector && !text && !urlIncludes) {
        throw new RbError("invalid_argument", "至少提供一个条件：selector / text / urlIncludes");
      }

      return ctx.run({}, async (page) => {
        const startedAt = Date.now();
        const deadline = startedAt + (args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const remaining = () => Math.max(200, deadline - Date.now());

        try {
          if (selector) await page.waitForSelector(selector, { timeout: remaining(), state: "attached" });
          if (text) {
            await page.waitForFunction((needle) => (document.body?.innerText || "").includes(needle), text, {
              timeout: remaining(),
            });
          }
          if (urlIncludes) {
            await page.waitForFunction((part) => location.href.includes(part), urlIncludes, {
              timeout: remaining(),
            });
          }
        } catch (err) {
          throw new RbError("selector_timeout", `等待超时：${errorText(err).split("\n")[0].slice(0, 160)}`);
        }

        const elapsedMs = Date.now() - startedAt;
        return json({ ok: true, matched: true, elapsedMs, ...(await summarize(page)) });
      });
    }
  );
}