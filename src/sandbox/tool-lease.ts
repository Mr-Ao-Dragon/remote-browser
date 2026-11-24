import type { AgsClient } from "../ags/client.js";
import { config } from "../config.js";
import { errorText, log } from "../logger.js";
import { countLiveInstances, deleteSandboxTool, ensureSandboxTool } from "./provisioner.js";

/**
 * 沙箱工具的按需租约。
 *
 * - 首次真正要起实例时才创建（启动阶段不占配额）；
 * - 同一进程内 singleflight，创建结果复用；
 * - 只回收本进程创建的工具，RB_TOOL_ID / 复用的工具一律不动；
 * - 删除前同时检查本地会话与云端实例，避免把在跑的沙箱脚下抽走。
 */
export class ToolLease {
  private toolId?: string;
  private owned = false;
  private acquiring?: Promise<string>;
  private lastUsed = Date.now();
  private sweeper?: NodeJS.Timeout;
  private releasing = false;
  private disposed = false;

  constructor(
    private readonly client: AgsClient,
    /** 返回 true 表示此刻可以删除工具（本地已无会话，且云端无在途实例）。 */
    private readonly canReleaseNow: () => Promise<boolean>
  ) {}

  /** 取一个可用工具；必要时创建。 */
  async acquire(): Promise<string> {
    if (this.toolId) {
      this.lastUsed = Date.now();
      return this.toolId;
    }
    if (this.acquiring) return this.acquiring;

    this.acquiring = (async () => {
      const tool = await ensureSandboxTool(this.client);
      this.toolId = tool.id;
      this.owned = tool.owned;
      this.lastUsed = Date.now();
      log.info("sandbox tool leased", { created: tool.owned });
      return tool.id;
    })();

    try {
      return await this.acquiring;
    } finally {
      this.acquiring = undefined;
    }
  }

  /** 空闲回收定时器，仅在配置了 RB_TOOL_IDLE_MS 时启动。 */
  start(): void {
    if (this.sweeper || config.toolIdleMs <= 0) return;
    const interval = Math.max(5_000, Math.min(60_000, Math.floor(config.toolIdleMs / 3)));
    this.sweeper = setInterval(() => {
      void this.releaseIfIdle().catch((err) => log.warn("tool release failed", { error: errorText(err) }));
    }, interval);
    this.sweeper.unref?.();
  }

  /** 空闲超时且无任何在途实例时删除工具。 */
  async releaseIfIdle(): Promise<void> {
    if (Date.now() - this.lastUsed < config.toolIdleMs) return;
    await this.release("idle");
  }

  /** 进程退出：按配置决定是否删除本进程创建的工具。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    if (!config.toolDeleteOnExit) return;
    await this.release("shutdown").catch((err) => log.warn("tool cleanup failed", { error: errorText(err) }));
  }

  private async canRelease(): Promise<boolean> {
    if (this.releasing || this.acquiring) return false;
    if (!this.toolId || !this.owned) return false;
    return this.canReleaseNow();
  }

  private async release(reason: string): Promise<void> {
    if (!(await this.canRelease())) return;
    this.releasing = true;
    try {
      const toolId = this.toolId!;
      const live = await countLiveInstances(this.client, toolId);
      if (live > 0) {
        log.debug("tool still has live instances", { live, reason });
        return;
      }
      await deleteSandboxTool(this.client, toolId);
      this.toolId = undefined;
      this.owned = false;
      log.info("sandbox tool released", { reason });
    } finally {
      this.releasing = false;
    }
  }
}