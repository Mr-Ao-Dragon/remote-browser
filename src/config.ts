import os from "node:os";
import path from "node:path";

export type IdleAction = "PAUSE" | "STOP";
export type TransportKind = "STDIO" | "HTTP";
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface Config {
  readonly region: string;
  readonly dataPlaneDomain: string;

  readonly secretId: string;
  readonly secretKey: string;
  readonly credFile: string;
  readonly roleArn: string;
  readonly roleSessionName: string;

  readonly toolId: string;
  readonly toolName: string;
  /** 工具空闲多久后删除（0 表示不回收，只保留本进程创建的工具）。 */
  readonly toolIdleMs: number;
  /** 进程退出时是否删除本进程创建的工具。 */
  readonly toolDeleteOnExit: boolean;
  readonly toolTimeout: string;
  readonly instanceTimeout: string;
  readonly sandboxPort: number;

  readonly idleMs: number;
  readonly idleAction: IdleAction;
  readonly startTimeoutMs: number;
  readonly cdpTimeoutMs: number;
  readonly ttlRenewIntervalMs: number;

  readonly maxSessions: number;
  readonly maxTools: number;
  readonly maxPaused: number;

  readonly transport: TransportKind;
  readonly httpPort: number;
  readonly httpHost: string;

  readonly logLevel: LogLevel;
  readonly debug: boolean;
}

function text(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = text(name, "").toUpperCase();
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export const config: Config = Object.freeze({
  region: text("TC_REGION", "ap-shanghai"),
  dataPlaneDomain: text("TC_DATA_PLANE_DOMAIN", "tencentags.com"),

  secretId: text("TC_SECRET_ID", ""),
  secretKey: text("TC_SECRET_KEY", ""),
  credFile: text("TC_CRED_FILE", path.join(os.homedir(), "Downloads", "SecretKey (1).csv")),
  roleArn: text("TC_ROLE_ARN", ""),
  roleSessionName: text("TC_ROLE_SESSION_NAME", "remote-browser"),

  toolId: text("RB_TOOL_ID", ""),
  toolName: text("RB_TOOL_NAME", "remote-browser"),
  toolIdleMs: positiveInt("RB_TOOL_IDLE_MS", 0),
  toolDeleteOnExit: text("RB_TOOL_DELETE_ON_EXIT", "") === "1",
  toolTimeout: text("RB_TOOL_TIMEOUT", "5m"),
  instanceTimeout: text("RB_INSTANCE_TIMEOUT", "5m"),
  sandboxPort: positiveInt("RB_SANDBOX_PORT", 9000),

  idleMs: positiveInt("RB_IDLE_MS", 90_000),
  idleAction: oneOf("RB_IDLE_ACTION", ["PAUSE", "STOP"] as const, "PAUSE"),
  startTimeoutMs: positiveInt("RB_START_TIMEOUT_MS", 120_000),
  cdpTimeoutMs: positiveInt("RB_CDP_TIMEOUT_MS", 90_000),
  ttlRenewIntervalMs: positiveInt("RB_TTL_RENEW_MS", 120_000),

  maxSessions: positiveInt("RB_MAX_SESSIONS", 10),
  maxTools: positiveInt("RB_MAX_TOOLS", 10),
  maxPaused: positiveInt("RB_MAX_PAUSED", 20),

  transport: oneOf("RB_TRANSPORT", ["STDIO", "HTTP"] as const, "STDIO"),
  httpPort: positiveInt("RB_HTTP_PORT", 8787),
  httpHost: text("RB_HTTP_HOST", "127.0.0.1"),

  logLevel: oneOf("RB_LOG_LEVEL", ["DEBUG", "INFO", "WARN", "ERROR"] as const, "INFO"),
  debug: text("RB_DEBUG", "") === "1",
});