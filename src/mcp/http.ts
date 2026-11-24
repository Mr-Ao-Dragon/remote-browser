import http from "node:http";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config.js";
import { errorText, log } from "../logger.js";
import type { SessionManager } from "../session/manager.js";
import { createMcpServer } from "./server.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/** 每次 initialize 建一个独立的 MCP server + transport，按 session ID 索引。 */
class HttpSessionRegistry {
  private readonly entries = new Map<string, SessionEntry>();

  constructor(private readonly manager: SessionManager) {}

  get(sessionId: string | undefined): SessionEntry | undefined {
    return sessionId ? this.entries.get(sessionId) : undefined;
  }

  async create(): Promise<StreamableHTTPServerTransport> {
    const server = createMcpServer(this.manager);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        this.entries.set(sessionId, { transport, server });
        log.info("MCP session initialized");
      },
    });

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (!sessionId) return;
      this.entries.delete(sessionId);
      void this.manager.close(sessionId);
      log.info("MCP session closed");
    };

    await server.connect(transport);
    return transport;
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body) return resolve(undefined);
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function rpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

export async function runHttpServer(manager: SessionManager): Promise<void> {
  const registry = new HttpSessionRegistry(manager);

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === HEALTH_PATH) {
      sendJson(res, 200, { ok: true, ...manager.stats() });
      return;
    }
    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const header = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;
    const entry = registry.get(sessionId);

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      if (entry) {
        await entry.transport.handleRequest(req, res, body);
        return;
      }
      if (!sessionId && isInitializeRequest(body)) {
        const transport = await registry.create();
        await transport.handleRequest(req, res, body);
        return;
      }
      rpcError(res, sessionId ? 404 : 400, -32000, sessionId ? "session not found" : "invalid request");
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!entry) {
        rpcError(res, 404, -32001, "session not found");
        return;
      }
      await entry.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405).end();
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error("http request failed", { error: errorText(err) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.httpPort, config.httpHost, resolve);
  });
  log.info("MCP server ready", {
    transport: "http",
    host: config.httpHost,
    port: config.httpPort,
    path: MCP_PATH,
  });
}