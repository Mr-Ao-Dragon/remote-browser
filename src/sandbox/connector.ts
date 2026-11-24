import { chromium, type Browser, type Page } from "playwright-core";
import { RbError } from "../errors.js";

const POLL_INTERVAL_MS = 1_500;
const REQUEST_TIMEOUT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface BrowserConnection {
  browser: Browser;
  page: Page;
}

export interface ConnectorOptions {
  region: string;
  domain: string;
  port: number;
}

/**
 * 数据面连接：先通过 /cdp/json/version 拿到公网 ws 地址，再用 Playwright 连接。
 * 冷启动阶段数据面会先返回 502，这里按固定间隔重试。
 */
export class SandboxConnector {
  constructor(private readonly options: ConnectorOptions) {}

  async connect(instanceId: string, token: string, timeoutMs: number): Promise<BrowserConnection> {
    const wsUrl = await this.discover(instanceId, token, timeoutMs);
    const browser = await chromium.connectOverCDP(wsUrl, {
      headers: { "X-Access-Token": token },
      timeout: 60_000,
    });
    return { browser, page: await this.pickPage(browser) };
  }

  async disconnect(browser: Browser | undefined): Promise<void> {
    if (!browser) return;
    await browser.close().catch(() => undefined);
  }

  private async discover(instanceId: string, token: string, timeoutMs: number): Promise<string> {
    const url = `https://${this.host(instanceId)}/cdp/json/version`;
    const deadline = Date.now() + timeoutMs;
    let lastStatus = 0;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, {
          headers: { "X-Access-Token": token },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        lastStatus = res.status;
        if (res.ok) {
          const body = (await res.json()) as { webSocketDebuggerUrl?: string };
          if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
        }
        if (res.status === 401 || res.status === 403) {
          throw new RbError("credential_invalid", "沙箱实例拒绝了访问凭证");
        }
        if (res.status === 404) {
          throw new RbError("sandbox_not_ready", "沙箱实例不存在或已过期");
        }
      } catch (err) {
        if (err instanceof RbError) throw err;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new RbError(
      "sandbox_start_timeout",
      `等待浏览器就绪超时（${Math.round(timeoutMs / 1000)}s，最后 HTTP ${lastStatus || "无响应"}）`
    );
  }

  private host(instanceId: string): string {
    const { port, region, domain } = this.options;
    return `${port}-${instanceId}.${region}.${domain}`;
  }

  private async pickPage(browser: Browser): Promise<Page> {
    const context = browser.contexts()[0] || (await browser.newContext());
    return context.pages()[0] || (await context.newPage());
  }
}