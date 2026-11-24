import { config } from "./config.js";
import { redact, redactDeep } from "./redact.js";

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 } as const;

type Level = keyof typeof LEVELS;
type Fields = Record<string, unknown>;

function emit(level: Level, msg: string, fields?: Fields): void {
  if (LEVELS[level] < LEVELS[config.logLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: redact(msg),
    ...(fields ? redactDeep(fields) : {}),
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

/** 结构化日志：写 stderr，所有字段出口脱敏。 */
export const log = {
  debug: (msg: string, fields?: Fields) => emit("DEBUG", msg, fields),
  info: (msg: string, fields?: Fields) => emit("INFO", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("WARN", msg, fields),
  error: (msg: string, fields?: Fields) => emit("ERROR", msg, fields),
};

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}