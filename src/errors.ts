import { redact } from "./redact.js";

export type RbErrorCode =
  | "invalid_argument"
  | "unsupported_url"
  | "credential_missing"
  | "credential_invalid"
  | "quota_exceeded"
  | "sandbox_start_timeout"
  | "sandbox_not_ready"
  | "browser_disconnected"
  | "selector_timeout"
  | "navigation_failed"
  | "extract_failed"
  | "tool_unavailable"
  | "sandbox_error"
  | "internal_error";

export class RbError extends Error {
  readonly code: RbErrorCode;
  readonly publicMessage: string;

  constructor(code: RbErrorCode, publicMessage: string, cause?: unknown) {
    super(publicMessage);
    this.name = "RbError";
    this.code = code;
    this.publicMessage = publicMessage;
    this.cause = cause;
  }
}

export interface PublicError {
  ok: false;
  code: RbErrorCode;
  message: string;
}

interface SdkError {
  code?: string;
  message?: string;
}

const CODE_MAP: Array<[RegExp, RbErrorCode]> = [
  [/^AuthFailure/i, "credential_invalid"],
  [/^UnauthorizedOperation/i, "credential_invalid"],
  [/^LimitExceeded/i, "quota_exceeded"],
  [/^ResourceInsufficient/i, "quota_exceeded"],
  [/^ResourceInUse/i, "sandbox_error"],
  [/^ResourceNotFound|^InvalidParameter$/i, "invalid_argument"],
  [/^RequestLimitExceeded/i, "sandbox_error"],
];

/** 将任意异常收敛成可返回给 Agent 的稳定结构，绝不带原始凭证。 */
export function toPublicError(err: unknown): PublicError {
  if (err instanceof RbError) {
    return { ok: false, code: err.code, message: err.publicMessage };
  }
  const e = err as SdkError;
  const rawCode = typeof e?.code === "string" ? e.code : "";
  const matched = CODE_MAP.find(([pattern]) => pattern.test(rawCode));
  const code: RbErrorCode = matched ? matched[1] : "sandbox_error";
  const message = redact(typeof e?.message === "string" && e.message ? e.message : String(err));
  return { ok: false, code, message: message.slice(0, 400) };
}

/** 腾讯云 SDK 的错误码，用于分支判断。 */
export function errorCode(err: unknown): string {
  const code = (err as SdkError)?.code;
  return typeof code === "string" ? code : "";
}

/** 资源已不存在：停止、暂停、续期都把它视为成功。 */
export function isNotFoundError(err: unknown): boolean {
  const message = (err as Error)?.message || "";
  return /ResourceNotFound|NotFound|does not exist|has been deleted/i.test(`${errorCode(err)} ${message}`);
}