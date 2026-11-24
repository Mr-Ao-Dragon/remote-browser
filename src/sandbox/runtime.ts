import type { Browser, Page } from "playwright-core";
import type { AgsClient } from "../ags/client.js";
import { config } from "../config.js";
import { errorCode, isNotFoundError, RbError } from "../errors.js";
import { log } from "../logger.js";
import { SandboxConnector } from "./connector.js";
import { SandboxInstances } from "./instances.js";
import type { ToolLease } from "./tool-lease.js";

export interface SandboxBrowser {
  instanceId: string;
  token: string;
  browser: Browser;
  page: Page;
}

/**
 * 沙箱运行时：把控制面实例操作与数据面 CDP 连接组合成一个
 * 「按会话取一个能用的浏览器」的接口。Token 只存在内存。
 */
export class SandboxRuntime {
  private readonly instances: SandboxInstances;
  private readonly connector: SandboxConnector;

  constructor(
    private readonly client: AgsClient,
    private readonly tool: ToolLease
  ) {
    this.instances = new SandboxInstances(client);
    this.connector = new SandboxConnector({
      region: config.region,
      domain: config.dataPlaneDomain,
      port: config.sandboxPort,
    });
  }

  /** 新建实例并连接到 CDP；工具不存在时会先按需创建。 */
  async start(): Promise<SandboxBrowser> {
    const t0 = Date.now();
    const toolId = await this.tool.acquire();
    const instanceId = await this.instances.start(toolId, config.instanceTimeout);
    log.info("sandbox instance created", { tookMs: Date.now() - t0 });
    return this.attach(instanceId);
  }

  /** 恢复暂停实例并重新建立连接，页面状态保留在实例内存里。 */
  async resume(instanceId: string): Promise<SandboxBrowser> {
    await this.instances.resume(instanceId, config.instanceTimeout);
    return this.attach(instanceId);
  }

  async pause(instanceId: string): Promise<void> {
    await this.instances.pause(instanceId);
  }

  async stop(instanceId: string): Promise<void> {
    await this.instances.stop(instanceId);
  }

  /** 续期 TTL。持久实例会返回 UnsupportedOperation，忽略即可。 */
  async renew(instanceId: string): Promise<void> {
    try {
      await this.instances.renew(instanceId, config.instanceTimeout);
    } catch (err) {
      if (isNotFoundError(err) || /UnsupportedOperation/i.test(errorCode(err))) return;
      log.warn("ttl renew failed", { code: errorCode(err) });
    }
  }

  async disconnect(browser: Browser | undefined): Promise<void> {
    await this.connector.disconnect(browser);
  }

  private async attach(instanceId: string): Promise<SandboxBrowser> {
    await this.instances.waitRunning(instanceId, config.startTimeoutMs);
    const token = await this.acquireToken(instanceId);
    const { browser, page } = await this.connector.connect(instanceId, token, config.cdpTimeoutMs);
    return { instanceId, token, browser, page };
  }

  private async acquireToken(instanceId: string): Promise<string> {
    const res = (await this.client.AcquireSandboxInstanceToken({ InstanceId: instanceId })) as { Token?: string };
    if (!res.Token) throw new RbError("sandbox_error", "获取沙箱访问凭证失败");
    return res.Token;
  }
}