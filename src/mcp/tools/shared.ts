import type { Page } from "playwright-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import { RbError, toPublicError } from "../../errors.js";
import { log } from "../../logger.js";
import type { RunOptions, SessionManager } from "../../session/manager.js";

const MAX_TITLE_LENGTH = 300;

export interface ToolDefinition {
  title: string;
  description: string;
  inputSchema: ZodRawShape;
}

export interface ToolContext {
  sessionKey: string;
  run<T>(options: RunOptions, fn: (page: Page) => Promise<T>): Promise<T>;
}

type Handler<Args> = (args: Args, ctx: ToolContext) => Promise<CallToolResult>;

export function json(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/**
 * 注册一个工具并统一处理会话绑定与错误收敛：
 * 工具实现只关心业务，异常一律转成脱敏后的 `{ok:false, code, message}`。
 */
export function registerTool<Args extends object>(
  server: McpServer,
  manager: SessionManager,
  name: string,
  definition: ToolDefinition,
  handler: Handler<Args>
): void {
  server.registerTool(name, definition, async (args, extra) => {
    const sessionKey = (extra as { sessionId?: string }).sessionId || "local";
    const ctx: ToolContext = {
      sessionKey,
      run: (options, fn) => manager.run(sessionKey, options, fn),
    };
    try {
      return await handler(args as Args, ctx);
    } catch (err) {
      const publicError = toPublicError(err);
      log.debug("tool failed", { tool: name, code: publicError.code });
      return { content: [{ type: "text", text: JSON.stringify(publicError) }], isError: true };
    }
  });
}

/** 只允许 http/https，其余协议直接拒绝，避免 file:// 之类的意外访问。 */
export function requireHttpUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RbError("invalid_argument", "url 不是合法地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RbError("unsupported_url", "只支持 http/https 地址");
  }
  return parsed.toString();
}

export function requireSelector(raw: string): string {
  const selector = raw.trim();
  if (!selector) throw new RbError("invalid_argument", "selector 不能为空");
  return selector;
}

export interface PageSummary {
  url: string;
  title: string;
}

export async function summarize(page: Page): Promise<PageSummary> {
  const title = await page.title().catch(() => "");
  return { url: page.url(), title: String(title).slice(0, MAX_TITLE_LENGTH) };
}