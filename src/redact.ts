/**
 * 日志与对外错误信息脱敏。
 * 页面内容（标题、正文、截图）由业务通道返回，不走这里。
 */

const registered = new Set<string>();

/** 启动时把 SecretId / SecretKey 等注册进黑名单，按字面替换。 */
export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const v = String(value).trim();
  if (v.length < 8) return;
  registered.add(v);
}

const LITERAL_PATTERNS: Array<[RegExp, string]> = [
  // 沙箱/部署 Token
  [/\b(sit|dpt)_[A-Za-z0-9_-]{6,}/g, "$1_***"],
  // 腾讯云 SecretId
  [/\bAKID[A-Za-z0-9]{10,}/g, "AKID***"],
  // 沙箱实例/部署数据面域名（实例 ID 长度随平台变化，按 16+ 宽松匹配）
  [/\b\d{4,5}-[a-z0-9]{16,}\.[a-z0-9-]+\.internal\.tencentags\.com\b/gi, "<sandbox-host>"],
  [/\b\d{4,5}-[a-z0-9]{16,}\.[a-z0-9-]+\.tencentags\.com\b/gi, "<sandbox-host>"],
  // 部署 ID
  [/\bdpl-[a-z0-9]{6,}\b/g, "dpl-***"],
  // 沙箱工具 ID
  [/\bsdt-[a-z0-9]{6,}\b/g, "sdt-***"],
  // 独立出现的实例 ID（实测 40+ 位，取 32+ 兜底）
  [/(?<![A-Za-z0-9])[a-z0-9]{32,}(?![A-Za-z0-9])/g, "<id>"],
  // 内网地址
  [/\b[a-z0-9-]+\.internal\.tencentags\.com\b/gi, "<internal-host>"],
  // JWT / 长 base64 凭证
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<jwt>"],
  // 请求头形式的 token
  [/(X-Access-Token["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1***"],
  [/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, "$1***"],
];

/** 返回脱敏后的字符串，可安全写日志或返回给 Agent。 */
export function redact(input: unknown): string {
  let text = typeof input === "string" ? input : input instanceof Error ? input.message : JSON.stringify(input);
  if (!text) text = "";
  for (const secret of registered) {
    if (secret && text.includes(secret)) text = text.split(secret).join("***");
  }
  for (const [pattern, replacement] of LITERAL_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/** 对任意对象做深拷贝式脱敏，用于对外返回值兜底。 */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}