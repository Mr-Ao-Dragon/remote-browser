import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "debug", version: "1.0.0" }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.RB_URL || "http://127.0.0.1:8791/mcp")));

const j = (r) => JSON.parse((r.content || []).find((c) => c.type === "text").text);

console.log("nav", j(await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com" } })));

const ex = await client.callTool({
  name: "browser_extract",
  arguments: {
    schema: {
      fields: {
        docTitle: { selector: "head > title", type: "text" },
        h1: { selector: "h1", type: "text" },
        h1exists: { selector: "h1", type: "exists" },
        h1count: { selector: "h1", type: "count" },
        bodyText: { selector: "body", type: "text" },
      },
    },
  },
});
const d = j(ex);
console.log("extract", JSON.stringify({ ...d, data: { ...d.data, bodyText: String(d.data?.bodyText).slice(0, 80) } }, null, 2));

const w = await client.callTool({ name: "browser_wait", arguments: { selector: "body", timeoutMs: 3000 } });
console.log("wait body", JSON.stringify(j(w)));

await client.callTool({ name: "browser_close", arguments: {} }).catch(() => {});
await client.close();