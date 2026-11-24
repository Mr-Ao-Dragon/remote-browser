import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RbError } from "../../errors.js";
import type { SessionManager } from "../../session/manager.js";
import { json, registerTool } from "./shared.js";

const FIELD_TYPES = ["text", "html", "href", "src", "value", "attribute", "count", "exists"] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldSpec {
  selector?: string;
  type?: FieldType;
  attr?: string;
}

export interface ExtractSpec {
  rowSelector?: string;
  fields: Record<string, FieldSpec>;
  limit?: number;
}

const fieldSchema = z.object({
  selector: z.string().optional().describe("相对字段选择器；不填表示当前行/整个文档"),
  type: z.enum(FIELD_TYPES).default("text").describe("取值方式"),
  attr: z.string().optional().describe("type=attribute 时要读取的属性名"),
});

const schemaDefinition = z.object({
  rowSelector: z.string().optional().describe("列表模式：每行的选择器；不填则返回单个对象"),
  fields: z.record(z.string(), fieldSchema).describe("字段名 -> 取值规则"),
  limit: z.number().int().min(1).max(200).optional().describe("列表模式最多返回多少行，默认 100"),
});

interface ExtractArgs {
  schema: ExtractSpec;
}

/** 在页面内执行，必须保持纯函数、只依赖传入的 spec。 */
function extractInPage(spec: ExtractSpec): unknown {
  const read = (element: Element | null, field: FieldSpec): unknown => {
    if (!element) return null;
    switch (field.type ?? "text") {
      case "text":
        return ((element as HTMLElement).innerText ?? element.textContent ?? "").trim();
      case "html":
        return element.innerHTML;
      case "href":
        return element.getAttribute("href");
      case "src":
        return element.getAttribute("src");
      case "value":
        return (element as HTMLInputElement).value ?? element.getAttribute("value");
      case "attribute":
        return field.attr ? element.getAttribute(field.attr) : null;
      case "count":
        return field.selector ? element.querySelectorAll(field.selector).length : 1;
      case "exists":
        return true;
      default:
        return null;
    }
  };

  const collect = (
    root: ParentNode,
    fallback: Element | null,
    fields: Record<string, FieldSpec>
  ): Record<string, unknown> => {
    const item: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(fields)) {
      item[name] = read(field.selector ? root.querySelector(field.selector) : fallback, field);
    }
    return item;
  };

  if (spec.rowSelector) {
    const rows = Array.from(document.querySelectorAll(spec.rowSelector)).slice(0, spec.limit ?? 100);
    return rows.map((row) => collect(row, row, spec.fields));
  }
  return collect(document, document.body, spec.fields);
}

export function registerExtractTool(server: McpServer, manager: SessionManager): void {
  registerTool<ExtractArgs>(
    server,
    manager,
    "browser_extract",
    {
      title: "结构化提取",
      description:
        "按声明式 schema 从当前页面提取结构化数据。列表模式提供 rowSelector，逐行套用 fields；非列表模式返回单个对象。",
      inputSchema: { schema: schemaDefinition },
    },
    async (args, ctx) => {
      const spec = args.schema;
      if (!spec?.fields || Object.keys(spec.fields).length === 0) {
        throw new RbError("invalid_argument", "fields 不能为空");
      }
      return ctx.run({}, async (page) => json({ ok: true, data: await page.evaluate(extractInPage, spec) }));
    }
  );
}