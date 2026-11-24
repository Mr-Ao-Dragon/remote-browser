import type { Page } from "playwright-core";
import { config } from "../config.js";
import { RbError } from "../errors.js";
import { errorText, log } from "../logger.js";
import type { SandboxBrowser, SandboxRuntime } from "../sandbox/runtime.js";

export type SessionState = "starting" | "ready" | "paused" | "closed";

export interface RunOptions {
  /** 任务要求保留登录态/表单：空闲时只暂停，不销毁。 */
  persistState?: boolean;
}

interface Session {
  key: string;
  state: SessionState;
  browser?: SandboxBrowser;
  instanceId?: string;
  persistState: boolean;
  lastUsed: number;
  lastRenew: number;
  /** 串行化同一会话内的操作，避免并发点击/导航互相踩踏。 */
  queue: Promise<unknown>;
  /** 启动/恢复的 singleflight。 */
  inflight?: Promise<SandboxBrowser>;
}

export interface SessionStats {
  total: number;
  ready: number;
  paused: number;
}

/**
 * 进程内会话管理：key 来自 MCP 传输层 sessionId（stdio 下固定为 local）。
 * 实例 ID 与 Token 只存在内存，不出现在工具签名或返回值中。
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private sweeper?: NodeJS.Timeout;
  private shuttingDown = false;

  constructor(private readonly runtime: SandboxRuntime) {}

  start(): void {
    if (this.sweeper) return;
    const interval = Math.max(2_000, Math.min(10_000, Math.floor(config.idleMs / 3)));
    this.sweeper = setInterval(() => {
      this.sweep().catch((err) => log.warn("idle sweep failed", { error: errorText(err) }));
    }, interval);
    this.sweeper.unref?.();
  }

  stats(): SessionStats {
    const all = [...this.sessions.values()];
    return {
      total: all.length,
      ready: all.filter((session) => session.state === "ready").length,
      paused: all.filter((session) => session.state === "paused").length,
    };
  }

  /** 是否还有未释放的会话（含启动中与暂停态）。 */
  hasLiveSessions(): boolean {
    for (const session of this.sessions.values()) {
      if (session.state !== "closed") return true;
    }
    return false;
  }

  /** 销毁长时间未使用的暂停会话，为工具回收清场。 */
  async stopIdlePaused(maxIdleMs: number): Promise<number> {
    let stopped = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.state !== "paused") continue;
      if (Date.now() - session.lastUsed < maxIdleMs) continue;
      try {
        await this.release(session, "STOP");
      } catch (err) {
        log.warn("failed to stop idle paused sandbox", { error: errorText(err) });
      }
      this.sessions.delete(session.key);
      stopped += 1;
    }
    return stopped;
  }

  /** 在指定会话中执行浏览器操作，自动完成懒启动、恢复与串行化。 */
  async run<T>(key: string, options: RunOptions, fn: (page: Page) => Promise<T>): Promise<T> {
    if (this.shuttingDown) throw new RbError("sandbox_error", "服务正在退出，暂不接受新请求");

    const session = this.acquire(key);
    if (options.persistState !== undefined) session.persistState = options.persistState;

    const task = async (): Promise<T> => {
      const live = await this.ensureBrowser(session);
      const result = await fn(live.page);
      session.lastUsed = Date.now();
      await this.renewIfDue(session);
      return result;
    };

    const run = session.queue.then(task, task);
    session.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** 显式关闭会话并停止实例。 */
  async close(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    await this.release(session, "STOP");
  }

  /** 优雅退出：并发停止所有实例，失败的只记录数量。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.sweeper) clearInterval(this.sweeper);

    const all = [...this.sessions.values()];
    this.sessions.clear();

    let failed = 0;
    await Promise.all(
      all.map(async (session) => {
        try {
          await this.release(session, "STOP");
        } catch {
          failed += 1;
        }
      })
    );

    if (failed > 0) log.error("shutdown left some sandboxes unreleased", { failed, total: all.length });
    else log.info("all sandboxes released", { total: all.length });
  }

  private acquire(key: string): Session {
    const existing = this.sessions.get(key);
    if (existing) return existing;

    if (this.sessions.size >= config.maxSessions) {
      throw new RbError(
        "quota_exceeded",
        `同时活跃的浏览器会话已达上限（${this.sessions.size}/${config.maxSessions}），请先关闭不用的会话`
      );
    }

    const session: Session = {
      key,
      state: "starting",
      persistState: false,
      lastUsed: Date.now(),
      lastRenew: Date.now(),
      queue: Promise.resolve(),
    };
    this.sessions.set(key, session);
    return session;
  }

  private async ensureBrowser(session: Session): Promise<SandboxBrowser> {
    if (session.browser?.browser.isConnected()) {
      session.state = "ready";
      return session.browser;
    }
    if (session.inflight) return session.inflight;

    session.inflight = (async () => {
      if (session.browser) {
        await this.runtime.disconnect(session.browser.browser);
        session.browser = undefined;
      }

      const live = await this.startOrResume(session);
      session.browser = live;
      session.instanceId = live.instanceId;
      session.state = "ready";
      session.lastUsed = Date.now();
      session.lastRenew = Date.now();
      return live;
    })();

    try {
      return await session.inflight;
    } finally {
      session.inflight = undefined;
    }
  }

  private async startOrResume(session: Session): Promise<SandboxBrowser> {
    if (session.instanceId && session.state === "paused") {
      log.info("resuming sandbox for session", { session: session.key });
      try {
        return await this.runtime.resume(session.instanceId);
      } catch (err) {
        log.warn("resume failed, recycling sandbox", { session: session.key, error: errorText(err) });
        await this.runtime.stop(session.instanceId).catch(() => undefined);
        session.instanceId = undefined;
      }
    }
    log.info("starting sandbox for session", { session: session.key });
    return this.runtime.start();
  }

  private async renewIfDue(session: Session): Promise<void> {
    if (!session.instanceId) return;
    if (Date.now() - session.lastRenew < config.ttlRenewIntervalMs) return;
    session.lastRenew = Date.now();
    await this.runtime.renew(session.instanceId);
  }

  /** PAUSE 保留状态，STOP 彻底释放。 */
  private async release(session: Session, action: "PAUSE" | "STOP"): Promise<void> {
    if (session.state === "closed") return;

    const browser = session.browser;
    session.browser = undefined;
    session.state = "closed";
    await this.runtime.disconnect(browser?.browser);

    const instanceId = session.instanceId;
    session.instanceId = undefined;
    if (!instanceId) return;

    if (action === "PAUSE") {
      await this.runtime.pause(instanceId);
      session.instanceId = instanceId;
      session.state = "paused";
      session.lastUsed = Date.now();
    } else {
      await this.runtime.stop(instanceId);
    }
  }

  /** 空闲回收：非持久会话按配置 PAUSE/STOP；暂停实例超限时淘汰最久未用的。 */
  private async sweep(): Promise<void> {
    const now = Date.now();
    const paused: Session[] = [];

    for (const session of this.sessions.values()) {
      if (session.state === "paused") {
        paused.push(session);
        continue;
      }
      if (session.state !== "ready" || now - session.lastUsed < config.idleMs) continue;

      const action = session.persistState ? "PAUSE" : config.idleAction;
      log.info("idle timeout reached", { session: session.key, action });
      try {
        if (action === "PAUSE") {
          await this.release(session, "PAUSE");
          paused.push(session);
        } else {
          await this.release(session, "STOP");
          this.sessions.delete(session.key);
        }
      } catch (err) {
        log.warn("idle release failed", { session: session.key, error: errorText(err) });
        this.sessions.delete(session.key);
      }
    }

    if (paused.length <= config.maxPaused) return;
    paused.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const session of paused.slice(0, paused.length - config.maxPaused)) {
      try {
        if (session.instanceId) await this.runtime.stop(session.instanceId);
      } catch (err) {
        log.warn("forced stop of paused sandbox failed", { session: session.key, error: errorText(err) });
      }
      session.instanceId = undefined;
      this.sessions.delete(session.key);
    }
  }
}