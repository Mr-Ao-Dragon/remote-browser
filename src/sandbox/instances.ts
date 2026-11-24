import type { AgsClient } from "../ags/client.js";
import { errorCode, isNotFoundError, RbError } from "../errors.js";

const POLL_INTERVAL_MS = 1_000;
const PAUSE_SETTLE_TIMEOUT_MS = 120_000;

const TERMINAL_STATES = new Set(["STOPPED", "STOP_FAILED", "FAILED", "PAUSE_FAILED"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 沙箱实例的控制面操作。
 * 只管实例状态，不碰 CDP 连接；Token 由调用方按需获取后随实例一起留在内存。
 */
export class SandboxInstances {
  constructor(private readonly client: AgsClient) {}

  /** 新建实例，返回实例 ID（此时通常已是 RUNNING，仍由调用方等待就绪）。 */
  async start(toolId: string, timeout: string): Promise<string> {
    const res = (await this.client.StartSandboxInstance({ ToolId: toolId, Timeout: timeout })) as {
      Instance?: { InstanceId?: string };
    };
    const instanceId = res.Instance?.InstanceId;
    if (!instanceId) throw new RbError("sandbox_error", "启动沙箱实例未返回实例标识");
    return instanceId;
  }

  /** 恢复暂停实例；暂停是异步的，可能仍处于 PAUSING，先等它落定。 */
  async resume(instanceId: string, timeout: string): Promise<void> {
    let state = await this.status(instanceId);
    if (state === "PAUSING") {
      state = await this.waitState(instanceId, ["PAUSED", "PAUSE_FAILED", "STOPPED"], PAUSE_SETTLE_TIMEOUT_MS);
    }
    if (TERMINAL_STATES.has(state)) {
      throw new RbError("sandbox_not_ready", "沙箱实例已失效，无法恢复");
    }
    if (state === "RUNNING") return;

    await this.client.ResumeSandboxInstance({ InstanceId: instanceId, Timeout: timeout }).catch((err) => {
      // 已恢复或已不在暂停态时视为成功
      if (!/already running|not paused/i.test(`${errorCode(err)} ${(err as Error)?.message || ""}`)) throw err;
    });
  }

  /** 暂停实例，保留内存与页面状态。幂等。 */
  async pause(instanceId: string): Promise<void> {
    await this.client.PauseSandboxInstance({ InstanceId: instanceId, Memory: true }).catch((err) => {
      if (isNotFoundError(err)) return;
      if (/already paused|not running|invalid status/i.test(`${errorCode(err)} ${(err as Error)?.message || ""}`)) return;
      throw err;
    });
  }

  /** 停止实例。幂等；已不存在视为成功。 */
  async stop(instanceId: string): Promise<void> {
    await this.client.StopSandboxInstance({ InstanceId: instanceId }).catch((err) => {
      if (isNotFoundError(err)) return;
      if (/already stopped|not running/i.test(`${errorCode(err)} ${(err as Error)?.message || ""}`)) return;
      throw err;
    });
  }

  /** 续期实例 TTL。持久实例不支持续期，由调用方忽略 UnsupportedOperation。 */
  async renew(instanceId: string, timeout: string): Promise<void> {
    await this.client.UpdateSandboxInstance({ InstanceId: instanceId, Timeout: timeout });
  }

  async status(instanceId: string): Promise<string> {
    const res = (await this.client.DescribeSandboxInstanceList({ InstanceIds: [instanceId], Limit: 10 })) as {
      InstanceSet?: Array<{ Status?: string }>;
    };
    return res.InstanceSet?.[0]?.Status || "UNKNOWN";
  }

  /** 等待实例 RUNNING；失败或停止时立即抛出。可容忍控制面限流。 */
  async waitRunning(instanceId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = "UNKNOWN";
    while (Date.now() < deadline) {
      try {
        last = await this.status(instanceId);
        if (last === "RUNNING") return;
        if (last === "FAILED" || last === "STOP_FAILED") {
          throw new RbError("sandbox_not_ready", `沙箱实例启动失败（${last}）`);
        }
        if (last === "STOPPED") throw new RbError("sandbox_not_ready", "沙箱实例已停止");
      } catch (err) {
        if (err instanceof RbError) throw err;
        if (!/RequestLimitExceeded|InternalError|ResourceUnavailable/i.test(errorCode(err))) throw err;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new RbError(
      "sandbox_start_timeout",
      `等待沙箱实例就绪超时（${Math.round(timeoutMs / 1000)}s，最后状态 ${last}）`
    );
  }

  private async waitState(instanceId: string, targets: string[], timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = "UNKNOWN";
    while (Date.now() < deadline) {
      last = await this.status(instanceId);
      if (targets.includes(last)) return last;
      await sleep(POLL_INTERVAL_MS);
    }
    return last;
  }
}