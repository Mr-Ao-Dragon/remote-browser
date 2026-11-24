# remote-browser 实施方案

> 面向腾讯云 Agent Runtime 的「随用随关」浏览器沙箱 MCP Server
> 版本：v0.2（实现完成，路线 B） 日期：2026-11-25 状态：已验收
>
> v0.2 变更：探针实测否定了路线 A（部署亲和不可用、部署入口返回内网 CDP），已按 §11 兜底方案落地为**路线 B：MCP Server 自管实例生命周期**。§0.1 是现状结论；§4–§7、§15 中涉及部署入口/Affinity 的描述保留作历史设计依据，实现以 §0.1 为准。

---

## 0. 文档范围与阅读说明

本文是**实施方案**，不是最终代码。目标是在动手前把架构、契约、参数、风险、验收路径全部钉死，避免在 Beta 能力上返工。

参数名一律以腾讯云官方文档原文为准，文中标注的「待探针验证」表示**文档未正面回答、必须实测**的假设。

---

## 0.1 实现结论（2026-11-25，以本节为准）

### 路线决策

| 假设 | 探针结论 | 结果 |
|---|---|---|
| 部署亲和 `EXCLUSIVE` / `STRICT` 可把同一会话固定到同一实例 | 恒返回 409 `affinity_conflict`，即使 `MinInstanceCount=1` 预热（探针 31/32） | 否 |
| `BEST_EFFORT` 可替代 | 同一 affinity 值仍落到不同实例；且经部署入口拿到的 `webSocketDebuggerUrl` 指向 `.internal.tencentags.com`，公网不可达（探针 26/28/29） | 否 |
| 实例直连（路线 B）可用 | 实例 ws 为**公网** `wss://9000-{instanceId}.{region}.tencentags.com/cdp/devtools/browser/{uuid}`，Playwright `connectOverCDP` 带 `X-Access-Token` 直连成功，navigate/截图/extract 正常（探针 29/33） | 是 |

因此实现走路线 B：`StartSandboxInstance → AcquireSandboxInstanceToken → connectOverCDP → Pause/Resume/Stop`，生命周期完全由 MCP Server 承担，不创建 Deployment。

### 实测参数基线

| 项 | 实测值 | 与文档差异 |
|---|---|---|
| `StartSandboxInstance` | 返回即 RUNNING，约 3.5s | — |
| `Timeout` 下限 | **300s（5m）** | 文档写 30s，实测 300s |
| `PauseSandboxInstance{Memory:true}` | 进入 `PAUSING` 后异步变 `PAUSED` | — |
| `ResumeSandboxInstance` | 约 2.6s，页面 URL / title / localStorage 完整保留 | — |
| 实例 ws 地址 | 公网 `.tencentags.com`，无需改写即可直连 | 文档未区分部署/实例两种形态 |
| 非持久实例 TTL 到期 | 自动 `STOPPED`，`StopReason=timeout` | 即 kill -9 安全网，最坏 5 分钟 |
| 持久实例 `UpdateSandboxInstance` 续期 | 报 `UnsupportedOperation.SandboxInstance` | 续期只对非持久实例生效 |
| `MaxInstanceRequestConcurrency=1` | 同一实例第二个并发 ws 会被拒 | 每个会话必须独占实例 |
| 自定义镜像 | `Command:["/init"]` + `Args` 注入启动脚本拉起 Chromium；nginx 9000 反代 `/cdp` → `127.0.0.1:9222` | Chromium 不会自动启动，必须自己拉起 |
| `CreateSandboxTool` | 提交 1.4s，`CREATING → ACTIVE` 约 2.6s（探针 36） | — |
| `DeleteSandboxTool` | 提交 1.0s，0.3s 后从列表消失；同名可立即重建（探针 36） | 删除比创建更快 |
| 工具配额 | 10 / 地域；删除后立即归还 | 与实例配额独立 |

### 资源按需策略（v0.3）

工具与实例分两级回收，默认都不预创建：

| 资源 | 何时创建 | 何时回收 | 开关 |
|---|---|---|---|
| 沙箱工具 | 首次需要起实例时 | 进程退出 / 空闲超时，且无本地会话、无云端活跃实例 | `RB_TOOL_DELETE_ON_EXIT=1`、`RB_TOOL_IDLE_MS` |
| 沙箱实例 | 首次工具调用 | 空闲 `RB_IDLE_MS`（PAUSE/STOP）、`browser_close`、进程退出、TTL 300s | 默认开启 |

约束：回收只作用于**本进程创建**的工具；`RB_TOOL_ID` 指定的或按名复用的既有工具一律不动，避免多进程/多 Agent 互踩。`Persistent=true` 永不使用——实测会在 `StopSandboxInstance` 后自动拉起实例并持续计费。

代价：懒创建首次调用约 7–9s（建工具约 4s + 起实例约 3.5s），预热后回到 3–4s。

### 验收结果

| 验收项 | 结果 |
|---|---|
| 7 个固定工具 | PASS |
| navigate 返回标题 | PASS |
| 空闲后无运行实例（PAUSE/STOP） | PASS（`scripts/test-lifecycle.mjs` 5/5） |
| kill -9 后自动释放 | PASS（TTL 300s 自动 STOPPED，`stopReason=timeout`） |
| 并发 10 个 navigate 不超上限 | PASS（`okCount=10`、`peak=10`、上限 50） |
| 日志 grep 不到凭证 | PASS（HTTP 验收 + stdio 冒烟双重检查） |
| 返回值不含实例 ID / Token / 内网地址 | PASS |

验证脚本：`scripts/acceptance.mjs`（HTTP，11 项）、`scripts/test-lifecycle.mjs`（生命周期，5 项）、`scripts/test-stdio.mjs`（stdio，7 项，含懒创建与退出回收）。

---

## 1. 决策记录（ADR）

| 编号 | 决策 | 结论 | 备注 |
|---|---|---|---|
| D1 | MCP 传输 | **stdio + streamable HTTP 均已实现** | `RB_TRANSPORT=STDIO|HTTP` 切换；stdio 为默认 |
| D2 | 空闲回收策略 | **混合：按任务显式选择 STOP / PAUSE** | 默认 PAUSE；非 `persistState` 任务可配 STOP |
| D3 | 控制面凭证 | **CAM 子账号 AK/SK + AssumeRole，环境变量或 CSV 二选一** | AssumeRole 优先；临时凭证只存内存 |
| D4 | 后端路线 | **路线 B（实例直连）** | 路线 A 经探针实测否定，见 §0.1 |
| D5 | 会话亲和 | 不使用部署亲和 | `EXCLUSIVE`/`STRICT` 恒 409；会话与实例在进程内一对一映射 |
| D6 | 端口暴露 | 只暴露 `9000`（nginx：CDP） | 9222 只在容器内监听 |
| D7 | 实现语言 | **TypeScript / Node 20（ESM）** | 腾讯云 SDK 为 CJS，用 `createRequire` 引入 |

---

## 2. 目标与非目标

### 2.1 目标

1. Agent 只看到 7 个无状态工具，不感知实例、会话、Token、生命周期。
2. 首次工具调用才拉起沙箱；空闲自动回收，不允许 24h 常驻。
3. 并发同会话请求共享一次启动（singleflight），不产生重叠实例。
4. MCP 进程被 `kill -9` 后，实例仍能在超时后自动释放。
5. 全链路日志与工具返回值不含任何凭证、实例 ID、内网地址。

### 2.2 非目标

- 不做 BrowserSkill 的 bsk daemon / 扩展 / 本地 IPC 协议（与 CDP 不是一套）。
- 不让 Agent 持有 CDP URL 或 Token。
- 不把实例级 Token 当服务长期凭证。
- 首版不做多租户计费、审计报表。

---

## 3. 已核实事实（文档基线）

| 能力 | 事实 | 来源 |
|---|---|---|
| 部署入口 | `https://{port}-{deployment-id}.{region}.agents.{data-plane-domain}` | [137850](https://cloud.tencent.com/document/product/1814/137850) |
| 部署鉴权 | Header `X-Access-Token`，`AcquireDeploymentToken` 返回 `Token`(`dpt_`) + `ExpiresAt` | [136842](https://cloud.tencent.com/document/api/1814/136842) |
| 部署入参 | `DeploymentName`、`ToolId`、`ScalingConfiguration`、`LifecycleConfiguration`、`AffinityConfiguration`、`Tags` | [136841](https://cloud.tencent.com/document/api/1814/136841) |
| 伸缩 | `MinInstanceCount`(≥0)、`MaxInstanceCount`(≥1)、`MaxInstanceRequestConcurrency`(≥1) | [137830](https://cloud.tencent.com/document/product/1814/137830) |
| 生命周期 | `IdleTimeoutSeconds`、`IdleAction=STOP|PAUSE` | [137830](https://cloud.tencent.com/document/product/1814/137830) |
| 亲和 | `Mode`=`BEST_EFFORT|STRICT|EXCLUSIVE`，`HeaderName` 默认 `X-Tencent-Agr-Affinity-Id`，创建后不可改 | [137831](https://cloud.tencent.com/document/product/1814/137831) |
| 部署绑定约束 | 必须绑定 `Persistent=true` 的沙箱工具，创建后不可更换 | [137850](https://cloud.tencent.com/document/product/1814/137850) |
| 浏览器 CDP | live url：`9000/novnc/vnc_lite.html?access_token=`；CDP：`9000/cdp?access_token=`；Playwright 带 `X-Access-Token` | [123852](https://cloud.tencent.com/document/product/1814/123852) |
| CDP 代理约束 | 9222 是原始 CDP，必须经 CDP 代理；只监听 `127.0.0.1:9222` 会 502 | [139439](https://cloud.tencent.com/document/product/1814/139439) |
| custom 工具 | `CustomConfiguration{Image,ImageRegistryType,Command,Args,Env,Ports,Resources,Probe}` | [132210](https://cloud.tencent.com/document/product/1814/132210) |
| 端口配额 | 8080 默认开放免声明；除 8080 外最多 3 个额外端口 | [129691](https://cloud.tencent.com/document/product/1814/129691) |
| 实例启动 | `ToolId/ToolName`、`Timeout`（默认 5m，最小 30s，最大 24h）、`StartMode`、`ClientToken` | [124816](https://cloud.tencent.com/document/api/1814/124816) |
| 实例 Token | `AcquireSandboxInstanceToken` 出参 `Token`/`ExpiresAt`/`TrafficToken` | [124818](https://cloud.tencent.com/document/api/1814/124818) |
| 实例查询 | `DescribeSandboxInstanceList`，支持 `InstanceIds`/`ToolId`/`Status` 过滤、`Limit/Offset` 或 `MaxResults/NextToken` | [124817](https://cloud.tencent.com/document/api/1814/124817) |
| 停止 | 停止不可回滚，网络端口与 Token 立即失效；`StopReason=manual|timeout|error|system` | [132338](https://cloud.tencent.com/document/product/1814/132338) |
| 地域 | Beta 公有云仅上海、香港；`CreateDeployment` API Region 枚举包含 5 个地域（矛盾，按 Beta 限制执行） | [137850](https://cloud.tencent.com/document/product/1814/137850) |
| 配额 | 单地域：工具 10、实例 50、暂停实例 20 | 需求给定 |

---

## 4. 总体架构

```
Agent ──(stdio, 只传业务参数)──> MCP Server (本地进程)
                                   │
                                   ├─ 控制面 SDK(CAM/APIKey/AssumeRole) ──> ags.tencentcloudapi.com
                                   │      └─ AcquireDeploymentToken (dpt_, 仅内存, 提前刷新)
                                   │
                                   └─ 数据面 (Playwright over CDP)
                                          wss://9000-{dpl}.{region}.agents.{domain}/cdp
                                          Header: X-Access-Token + X-Tencent-Agr-Affinity-Id
                                   │
                                   ▼
                        弹性部署 (Min=0, Max=10, Concurrency=1, Idle=120s, STOP, EXCLUSIVE)
                                   │
                                   ▼
                        浏览器沙箱实例 (browser-v1 / 自建 custom 镜像)
                          ├─ 9000  : /cdp (CDP 代理) + /novnc (live url)
                          └─ 49983 : envd 管理端口
```

### 4.1 语言选型

建议 **TypeScript / Node 20**：

- MCP 官方 SDK 对 stdio 支持最成熟，`McpServer` + `StdioServerTransport` 开箱即用。
- Playwright 的 `connect_over_cdp(url, { headers })` 原生支持自定义 Header，正好满足 `X-Access-Token` + Affinity。
- 腾讯云 Node SDK（`tencentcloud-sdk-nodejs`）覆盖 `ags` 产品与 `sts` 的 `AssumeRole`。
- 后续要打包成单文件可用 `bun build --compile` 或 `pkg`。

若团队更熟 Python，替换为 `mcp` + `playwright` + `tencentcloud-sdk-python`，分层设计不变。

### 4.2 分层

| 层 | 职责 | 关键约束 |
|---|---|---|
| `transport` | stdio 收发 | 不做任何业务逻辑；只做会话上下文注入 |
| `mcp` | 工具注册、参数校验、返回值白名单 | 签名不含 instanceId/sessionId/toolId/deploymentId |
| `session` | 逻辑会话注册、singleflight、idle timer | 进程内，不落盘 |
| `backend` | DeploymentAdapter / InstanceAdapter | 统一 `ensureReady/release/health` 接口 |
| `browser` | Playwright 操作封装 | 只持有内存句柄，不暴露 URL/Token |
| `auth` | 三源凭证 + Token 缓存 + 刷新 | Token 只存内存 |
| `observability` | 结构化日志 + 脱敏 + 错误归一 | 启动自检 + 出口过滤 |

---

## 5. 会话与生命周期设计

### 5.1 逻辑会话 key

| 传输 | sessionKey | 说明 |
|---|---|---|
| stdio | `stdio:<pid>:<boot-uuid>` | 一个 MCP 进程 = 一个逻辑会话；**多 Agent 共用需起多进程** |
| streamable HTTP（P2） | `mcp:<Mcp-Session-Id>` | 按 MCP 会话隔离 |

> stdio 的天然限制要在 README 写清楚：同一进程内所有工具调用共享一个浏览器上下文。若一个宿主同时服务多个互不相关的 Agent，应各自拉起独立进程。

### 5.2 会话状态

```ts
interface LogicalSession {
  key: string
  state: "idle" | "starting" | "ready" | "releasing"
  browser?: Browser          // Playwright Browser，仅内存
  cdpEndpoint?: string       // 仅内存，不落日志
  affinityId?: string        // 平台返回的 opaque id，仅内存
  mode: "ephemeral" | "persistent"
  lastActiveAt: number
  idleTimer?: NodeJS.Timeout
  startPromise?: Promise<Browser>   // singleflight
  pendingCalls: number
}
```

### 5.3 首次调用时序（懒启动）

```
tool call → session.get(key)
  ├─ 有 startPromise → await 同一个 promise（并发去重）
  ├─ state=ready    → touch()，直接执行
  └─ state=idle     → state=starting
       1. AcquireDeploymentToken（若缓存未过期则复用）
       2. 拼 CDP URL（§6.2）
       3. playwright.chromium.connect_over_cdp(url, { headers })
       4. 记录 affinityId（见 §6.3）
       5. state=ready，启动 idle timer
```

### 5.4 空闲回收

- `touch()` 每次成功调用后重置 timer。
- **本地 timer 必须短于平台 `IdleTimeoutSeconds`**：建议本地 90s，平台 120s。
- 到期动作：
  1. `browser.close()` / `disconnect`（断开 CDP，让平台感知连接结束）
  2. 清 `browser`、`cdpEndpoint`、`affinityId`
  3. state=idle
- **关键**：只要 MCP 一直持有 CDP WebSocket，平台会认为连接活跃，`IdleTimeoutSeconds` 永不触发。所以"主动断开"是随用随关的必要条件，不能只依赖平台。

### 5.5 STOP / PAUSE 混合策略

| 模式 | 平台配置 | MCP 行为 | 代价 |
|---|---|---|---|
| `ephemeral`（默认） | `IdleAction=STOP` | idle 到期断开，平台释放实例 | 下次重开，页面状态丢失 |
| `persistent`（显式） | `IdleAction=PAUSE` | idle 到期仅断开 CDP，保留实例 | 占用单地域 20 个暂停配额 |

**显式选择方式**：`browser_navigate` 增加可选业务参数 `persistState?: boolean`（默认 `false`）。

- 首次调用时决定该会话的 `mode`；后续调用以首次为准，若不一致，返回中带 `modeIgnored: true` 提示。
- **PAUSE 的回收坑**：部署模式没有主动 Stop 接口，`browser_close()` 也无法真正释放 PAUSE 实例。因此：
  - `persistent` 会话建议由运维用清理脚本定期 `agr instance delete`；
  - 或在部署层配置一个更短的兜底生命周期；
  - README 必须写明"persistent 不等于永久保留"。

### 5.6 singleflight

- `Map<sessionKey, Promise<Browser>>`；进程单线程，插入 promise 时同步完成，避免 await 间隙重复创建。
- 失败时清空 entry，下一个请求可重试；失败后的重试不自动重试第二次，直接回错（避免风暴）。

### 5.7 空闲回收与验收标准 2/3 的关系

- 验收 2（空闲后查不到运行实例）：依赖平台 `IdleTimeoutSeconds=120` + `IdleAction=STOP`；MCP 侧 90s 主动断开确保计时开始。
- 验收 3（kill -9 后实例自动停止）：部署模式靠平台 idle 兜底；**实例兜底模式必须显式设 `Timeout`（建议 300s）**，否则默认 5m 也可能不够快，且没有进程内回收。

---

## 6. 数据面连接设计

### 6.1 两种 URL 形态（不要混用）

| 模式 | URL | Token |
|---|---|---|
| 部署（路线 A） | `https://{port}-{deploymentId}.{region}.agents.{domain}` | `dpt_` 部署 Token |
| 实例（兜底） | `https://{port}-{instanceId}.{region}.{domain}` | 实例 Token + `TrafficToken` |

注意部署形态带 `.agents.` 段，实例形态不带。参数拼接必须按模式分支。

### 6.2 CDP URL 组装（部署模式）

```
wss://9000-{deploymentId}.{region}.agents.{domain}/cdp
```

- 文档只明确给了 **HTTP** 域名格式，`wss://` 是推断，**待探针 P1 验证**。
- 端口 9000 是 nginx 统一入口，`/cdp` 是 CDP 代理路径；**不要用 9222 或 `/json/version` 返回的原始 ws url**。
- Header：
  - `X-Access-Token: <dpt_...>`
  - `X-Tencent-Agr-Affinity-Id: <affinityId>`（首次不带）

### 6.3 亲和 ID 获取（关键设计点）

WebSocket 握手虽然返回 101 + headers，但 Playwright 不一定暴露握手响应头。因此采用**两段式**：

1. 先用一次轻量 HTTP 探测拿 Affinity ID：`GET https://9000-{dpl}.../health`（或 `/json/version`），Header 只带 `X-Access-Token`；
2. 从响应头读 `X-Tencent-Agr-Affinity-Id`，缓存到 session；
3. 再用 `connect_over_cdp` 带 `X-Access-Token` + `X-Tencent-Agr-Affinity-Id` 建立 CDP。

若探测回包不带 Affinity ID，说明部署可能未启用亲和（首请求无 ID、响应才下发），需在探针 P3 中确认响应头是否稳定下发。

### 6.4 两层 Token 的对齐（最大风险）

- 部署入口校验 `dpt_`；沙箱内 nginx `/cdp?access_token=` 可能还要实例 envd token。
- MCP Server 在部署模式下**拿不到实例 Token**（也不该拿）。
- 可行解法：
  1. `AuthMode=PUBLIC`：业务端口匿名，管理端口仍需 token；安全由部署入口的 `dpt_` 承担。**推荐先验证这条**。
  2. 若平台自动把 `dpt_` 映射为实例鉴权，则 `AuthMode=TOKEN` 也能通。
  3. 两者都不成立 → 触发兜底方案（§11）。
- 探针 P2 判定。

### 6.5 Playwright 连接参数

```ts
const browser = await chromium.connect_over_cdp(cdpUrl, {
  headers: {
    "X-Access-Token": deploymentToken,
    "X-Tencent-Agr-Affinity-Id": affinityId,
  },
  timeout: 30_000,
})
const ctx = browser.contexts[0] ?? await browser.newContext()
const page = ctx.pages()[0] ?? await ctx.newPage()
```

- 复用 `contexts[0]` 而不是每次 `newContext`，保证页面状态连续。
- 连接失败不自动重试；返回 `BROWSER_UNAVAILABLE`。

---

## 7. 鉴权设计

### 7.1 三源凭证（启动时择一）

| 来源 | 环境变量 | 优先级 | 说明 |
|---|---|---|---|
| AssumeRole 角色扮演 | `TC_ROLE_ARN` + `TC_SECRET_ID` + `TC_SECRET_KEY` | 1 | 用源凭证调 `sts:AssumeRole` 换临时凭证 |
| CAM 子账号 | `TC_SECRET_ID` + `TC_SECRET_KEY` | 2 | 最小权限子账号 |
| Agent Sandbox API Key | `AGS_API_KEY` | 3 | 长期有效，跟随账号权限 |

**AssumeRole 细节**：

- 接口：`AssumeRole`（`sts.tencentcloudapi.com`，Version `2018-08-13`）
- 入参：`RoleArn`、`RoleSessionName`（如 `remote-browser-<host>-<pid>`）、`DurationSeconds`（建议 3600）、可选 `Policy` 进一步收窄
- 出参：`Credentials.TmpSecretId` / `TmpSecretKey` / `Token` / `ExpiredTime`
- 提前 5 分钟刷新；刷新用 singleflight，避免并发打 STS

### 7.2 最小权限策略（子账号/角色都套用）

```
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": [
        "ags:CreateDeployment", "ags:DescribeDeployment", "ags:DescribeDeployments",
        "ags:ModifyDeployment", "ags:DeleteDeployment", "ags:AcquireDeploymentToken",
        "ags:CreateSandboxTool", "ags:DescribeSandboxTool", "ags:DescribeSandboxTools",
        "ags:StartSandboxInstance", "ags:StopSandboxInstance",
        "ags:DescribeSandboxInstanceList", "ags:DescribeSandboxInstance",
        "ags:AcquireSandboxInstanceToken"
      ],
      "resource": ["*"]
    }
  ]
}
```

> Action 命名以实际 CAM 产品前缀为准，上线前用 `cam:GetPolicy` / 控制台策略生成器复核。若首版只跑路线 A，可只保留 Deployment 相关 Action。

### 7.3 Token 缓存

```ts
interface TokenCache {
  token: string
  expiresAt: number   // epoch ms
}
```

- 只存内存，进程退出即丢。
- `get()` 时若 `expiresAt - now < 60s` 则刷新。
- 刷新失败：返回 `BROWSER_UNAVAILABLE`，不返回底层错误串。

### 7.4 禁止事项

- 不把 `dpt_` / 实例 Token / AK-SK / API Key 写入磁盘、日志、工具返回值。
- 不把实例 Token 当长期凭证复用超过其 `ExpiresAt`。
- 错误信息统一走 `sanitizeError()`，只映射到白名单错误码。

---

## 8. MCP 工具契约

### 8.1 通用返回

```ts
type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ErrorCode; message: string }  // message 已脱敏
```

错误码白名单：

| code | 含义 | 对 Agent 的提示 |
|---|---|---|
| `BROWSER_UNAVAILABLE` | 沙箱不可用 / 连接失败 | 稍后重试 |
| `NAVIGATION_FAILED` | 导航失败（DNS/证书/超时） | 检查 URL |
| `ELEMENT_NOT_FOUND` | 选择器未命中 | 检查 selector |
| `TIMEOUT` | 操作超时 | 调整条件或重试 |
| `QUOTA_EXCEEDED` | 并发/配额触顶 | 降低并发 |
| `INVALID_ARGUMENT` | 参数不合法 | 修正参数 |
| `INTERNAL_ERROR` | 兜底 | 联系管理员 |

### 8.2 工具定义

#### `browser_navigate(url, persistState?)`

- 入参：`url: string`；`persistState?: boolean`（默认 false）
- 行为：确保会话就绪 → `page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })`
- 返回：`{ title, url, status }`
- 验收 1 直接对应。

#### `browser_click(selector)`

- 行为：`page.locator(selector).click({ timeout: 10000 })`
- 返回：`{ ok: true, url }`
- 未命中 → `ELEMENT_NOT_FOUND`

#### `browser_type(selector, text)`

- 行为：`locator.fill(text)`（清空后输入）；如需追加可后续扩展
- 返回：`{ ok: true }`

#### `browser_screenshot(fullPage?)`

- 行为：`page.screenshot({ fullPage: !!fullPage, type: "png" })`
- 返回：MCP `image` content（base64 + mimeType），**不返回任何 URL**
- 大小上限：单张 ≤ 5MB，超过则降质或返回 `INTERNAL_ERROR`

#### `browser_extract(schema)`

- 入参：JSON Schema 对象
- 行为：
  1. 取 `page.content()` + `page.innerText()` + 可访问性树摘要
  2. 按 schema 字段名匹配 `data-testid` / `aria-label` / `name` / `id`
  3. 返回 `{ data, matched, unmatched }`
- 定位：**启发式抽取**，不保证 100%；`unmatched` 明确列给 Agent 兜底。
- 备选（更稳）：返回 `{ markdown, matched, unmatched }`，让 Agent 自己补抽。首版建议两者都返回。

#### `browser_wait(condition)`

- 条件语法（字符串前缀）：
  - `selector:<css>` → 元素可见
  - `text:<text>` → 文本出现
  - `url:<glob>` → URL 匹配
  - `networkidle` → 网络空闲
  - `ms:<number>` → 固定等待（上限 10000）
- 默认超时 10s，最大 30s
- 返回：`{ ok, elapsedMs }`

#### `browser_close()`

- 行为：断开 CDP → 清 session 句柄 → 停 idle timer
- 返回：`{ closed: true }`
- **语义澄清**：这是"结束当前浏览任务"，不是"立刻销毁实例"。部署模式下无法直接 Stop，实例由平台 idle 回收（ephemeral）或保留（persistent）。README 必须写明。

### 8.3 签名红线

- 任何工具参数 / 返回值不得出现：`instanceId`、`sessionId`、`toolId`、`deploymentId`、`token`、CDP URL、内网地址。
- `requestId` 可作为内部排查字段写日志，**不返回给 Agent**。

---

## 9. 并发与配额

### 9.1 并发闸门

- 进程内 semaphore，默认 `MAX_CONCURRENT_SESSIONS=10`。
- 超出后排队，排队超时 30s → `QUOTA_EXCEEDED`。
- 依据：单地域实例上限 50，给其他业务留余量；`MaxInstanceCount` 也设 10，双重约束。

### 9.2 参数建议值

| 参数 | 建议值 | 理由 |
|---|---|---|
| `MinInstanceCount` | 0 | 缩容到零 |
| `MaxInstanceCount` | 10 | 与 MCP semaphore 对齐 |
| `MaxInstanceRequestConcurrency` | 1 | 浏览器会话单连接 |
| `IdleTimeoutSeconds` | 120 | 需求建议 60–120 |
| `IdleAction` | STOP（persistent 会话可单独部署一套 PAUSE） | 随用随关 |
| `AffinityConfiguration.Mode` | EXCLUSIVE | 独占浏览器实例 |
| MCP 本地 idle | 90s | 必须 < 平台 idle |
| `StartSandboxInstance.Timeout` | 300s（兜底模式） | 保证 kill -9 后到期释放 |

### 9.3 PAUSE 配额

- 暂停实例上限 20。persistent 会话若超过阈值，按 LRU 淘汰（主动 `agr instance delete`）。
- 首版可直接把 persistent 并发限制为 5，留足余量。

---

## 10. 日志、脱敏与观测

### 10.1 日志

- 结构化 JSON（pino）。
- 字段白名单：`ts`、`level`、`event`、`sessionKey`（哈希后）、`tool`、`durationMs`、`errorCode`。
- **禁止字段**：`token`、`secretId`、`secretKey`、`apiKey`、`affinityId`、`cdpEndpoint`、`deploymentId`、`instanceId`、`url`（含 host）。

### 10.2 脱敏实现

1. pino `redact` 配置覆盖上述 key。
2. 自定义 serializer：URL 只保留 path，host 替换为 `<redacted-host>`。
3. `sanitizeError(err)`：把 SDK 错误映射为白名单 code + 固定文案，不带原始 message/requestId。
4. **启动自检**：进程启动时用一组伪造凭证跑一遍日志管线，断言输出不含伪造串；不通过则拒绝启动（可用 `SELF_CHECK=strict` 控制）。

### 10.3 验收 5（grep 无凭证）

```bash
grep -RInE 'AKID|dpt_|sk-|SecretKey|X-Access-Token' ./logs/ && echo FAIL || echo PASS
```

CI 里跑一遍，日志样本同时覆盖成功、失败、SIGTERM 三条路径。

---

## 11. 兜底方案与切换

### 11.1 触发条件

任一成立即切实例直连：

1. P1 失败：部署入口不支持 WSS。
2. P2 失败：`AuthMode=PUBLIC` 与 dpt 映射都无法让 `/cdp` 通过鉴权。
3. P3 失败：亲和 ID 无法稳定绑定到同一实例，导致每次调用都新建浏览器。

### 11.2 实例直连流程

```
StartSandboxInstance(ToolName, Timeout=300s, StartMode=WAIT_UNTIL_HEALTHY, ClientToken=hash(sessionKey+nonce))
  → InstanceId
AcquireSandboxInstanceToken(InstanceId)
  → Token / TrafficToken
拼 URL: https://{port}-{instanceId}.{region}.{domain}/...
执行工具
空闲/关闭 → StopSandboxInstance（幂等）
```

- **停止不可回滚**，停止后端口与 Token 立即失效。
- 幂等：对 `ResourceNotFound` / 已 `STOPPED` 直接视为成功，不重试。
- 句柄持久化：`orphan-handles.json`（加密，含 `instanceId` + `createdAt` + `mode`，**不含 Token**），下次启动尝试清理。
- 实例模式下 MCP 必须自己实现 idle timer + 主动 Stop，平台不再兜底；kill -9 时只能靠 `Timeout` 到期。

### 11.3 切换方式

`BACKEND_MODE=deployment|instance`，两套 Adapter 共用上层，切换不改工具契约。

---

## 12. 优雅退出

```
SIGTERM/SIGINT
  → 停止接受新调用
  → 对每个 session: browser.close()（断开 CDP）
  → deployment 模式：无需调 API，写退出日志即可
  → instance 模式：StopSandboxInstance（幂等）；失败则写 orphan-handles.json
  → flush 日志
  → exit(0)
```

- 释放失败不阻塞退出；记录句柄供下次清理。
- `kill -9` 无法捕获，依赖 §5.7 的兜底。

---

## 13. 目录结构

```
remote-browser/
├── src/
│   ├── index.ts               入口：组装依赖、注册信号、选择传输
│   ├── config.ts              环境变量解析（冻结的只读配置）
│   ├── errors.ts              RbError / 错误码收敛 / isNotFoundError
│   ├── logger.ts              结构化日志（stderr，出口脱敏）
│   ├── redact.ts              凭证与内网地址黑名单
│   ├── ags/
│   │   └── client.ts          凭证解析、AssumeRole、AGS 客户端
│   ├── sandbox/
│   │   ├── bootstrap.ts       沙箱内 Chromium 启动脚本
│   │   ├── provisioner.ts     定位/创建沙箱工具
│   │   ├── instances.ts       实例控制面：start/resume/pause/stop/renew/状态等待
│   │   ├── connector.ts       数据面：CDP 发现 + Playwright 连接
│   │   └── runtime.ts         组合上述两者，对外只暴露 start/resume/pause/stop/renew
│   ├── session/
│   │   └── manager.ts         会话映射、singleflight、串行队列、空闲回收、优雅退出
│   └── mcp/
│       ├── server.ts          McpServer 构建
│       ├── stdio.ts           stdio 传输
│       ├── http.ts            streamable HTTP 传输 + 会话注册表
│       └── tools/
│           ├── index.ts       注册 7 个工具
│           ├── shared.ts      统一错误收敛、会话绑定、URL/选择器校验
│           ├── navigate.ts click.ts type-text.ts
│           ├── screenshot.ts extract.ts wait.ts close.ts
├── docker/Dockerfile          可选的自定义镜像（基于官方镜像加字体/时区）
├── scripts/
│   ├── deploy.cjs             创建/复用沙箱工具
│   ├── cleanup.cjs            列出/停止遗留实例
│   ├── acceptance.mjs         HTTP 验收（11 项）
│   ├── test-lifecycle.mjs     生命周期验收（5 项）
│   ├── test-stdio.mjs         stdio 冒烟（6 项）
│   └── probes/                路线验证探针（历史，保留作证据）
├── docs/
│   ├── implementation-plan.md
│   └── cost.md
├── package.json
└── README.md
```

分层原则：`tools` 只做参数与页面操作；`session` 管并发与生命周期；`sandbox` 管实例与连接；`ags` 管凭证；`logger`/`redact`/`errors` 是横切关注点，不反向依赖业务层。

---

## 14. 沙箱镜像设计

### 14.1 两条路线

| 路线 | 做法 | 适用 |
|---|---|---|
| 官方镜像 | `ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest` + `ImageRegistryType=custom` | **当前采用**，含 `/init`、envd(49983)、nginx(9000→9222) |
| 自建镜像 | 基于官方镜像加字体/时区/证书 | 需要 CJK 字体等增量时，见 `docker/Dockerfile` |

### 14.2 实际工具参数（与 `src/sandbox/provisioner.ts` 一致）

```json
{
  "ToolName": "remote-browser",
  "ToolType": "custom",
  "NetworkConfiguration": { "NetworkMode": "PUBLIC" },
  "DefaultTimeout": "5m",
  "Persistent": false,
  "CustomConfiguration": {
    "Image": "ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest",
    "ImageRegistryType": "custom",
    "Command": ["/init"],
    "Args": ["/bin/sh", "-c", "<BROWSER_BOOTSTRAP>"],
    "Ports": [{ "Name": "web", "Port": 9000, "Protocol": "TCP" }],
    "Resources": { "CPU": "2", "Memory": "4Gi" },
    "Probe": {
      "HttpGet": { "Path": "/", "Port": 9000, "Scheme": "HTTP" },
      "ReadyTimeoutMs": 30000,
      "ProbeTimeoutMs": 3000,
      "ProbePeriodMs": 2000,
      "SuccessThreshold": 1,
      "FailureThreshold": 10
    }
  }
}
```

关键点：

- **Chromium 不会自动启动**。`/init` 负责 nginx 与 AGS 组件，浏览器必须由 `Args` 里的启动脚本拉起，并带崩溃重启循环：

```sh
set -u
C=$(command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable)
[ -z "$C" ] && { echo "chromium not found" >&2; exit 1; }
mkdir -p /tmp/cdpprofile
( while true; do "$C" --headless=new --no-sandbox --disable-dev-shm-usage \
    --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
    --user-data-dir=/tmp/cdpprofile about:blank >> /tmp/chrome.log 2>&1; sleep 1; done ) &
exec sleep infinity
```

- 9222 只在容器内监听，对外只有 nginx 的 9000；`/cdp` 反代到 9222。
- `Persistent=false` 是路线 B 的前提：只有非持久实例支持 TTL 自动停止与 `UpdateSandboxInstance` 续期。
- 只声明 9000；49983（envd）是管理面内部使用，不对外暴露。
- `CustomConfiguration.ImageDigest` 是只读字段，创建时会报 `UnknownParameter`，不要传。

### 14.3 端口

| 端口 | 用途 | 是否对外 |
|---|---|---|
| 9000 | nginx：`/cdp` → 127.0.0.1:9222，`/` 健康检查 | 是（数据面入口） |
| 9222 | Chromium 原始 CDP | 否，仅容器内 |
| 49983 | envd（AGS 管理面） | 否 |

---

## 15. 部署脚本

### 15.1 `scripts/deploy.cjs`（已实现）

一条命令完成工具创建或复用，不碰部署、不碰实例：

```bash
node scripts/deploy.cjs              # 创建或复用同名工具，输出 RB_TOOL_ID 与客户端配置
node scripts/deploy.cjs --dry-run    # 只打印将提交的参数
node scripts/deploy.cjs --list       # 列出现有工具
node scripts/deploy.cjs --name xxx   # 指定工具名
```

行为：

1. 凭证：`TC_SECRET_ID`/`TC_SECRET_KEY` 优先，否则读 `TC_CRED_FILE`；配了 `TC_ROLE_ARN` 先 AssumeRole。
2. `DescribeSandboxToolList` 找同名工具，存在且 ACTIVE 直接复用；否则 `CreateSandboxTool`。
3. 轮询到 ACTIVE（最多 180s）。
4. 打印 `RB_TOOL_ID`、`TC_REGION`、`RB_TRANSPORT` 和 stdio 客户端配置片段。
5. 全程不打印 SecretId / SecretKey / Token。

不创建 `Deployment`：路线 B 下不需要，也避开了亲和 409 与内网 CDP 两个坑。

### 15.2 验证脚本

| 脚本 | 覆盖 |
|---|---|
| `scripts/acceptance.mjs` | 7 工具、标题、实例数、无凭证泄漏、截图、extract、wait、click、非法 URL、并发、close |
| `scripts/test-lifecycle.mjs` | 懒启动、空闲暂停、同实例恢复保留 URL、`persistState` 恢复、close 释放 |
| `scripts/test-stdio.mjs` | stdio 握手、工具面、navigate、截图、close、stderr 脱敏 |

三者都直接调控制面 API 核对实例状态，不依赖人工观察。

---

## 16. 验收用例映射

| # | 验收标准 | 测试步骤 | 断言 |
|---|---|---|---|
| 1 | navigate 返回标题 | 全新环境启动 → `browser_navigate("https://cloud.tencent.com")` | `ok=true` 且 `title` 非空 |
| 2 | 空闲后无运行实例 | navigate → 等 150s → `DescribeSandboxInstanceList` | `RUNNING` 数量为 0 |
| 3 | kill -9 后自动释放 | navigate → `kill -9` → 等 150s（部署）/ 300s（实例） | `RUNNING` 数量为 0 |
| 4 | 并发 10 个 navigate | 并发 10 个 navigate → 采样实例列表 | 峰值 ≤ 10，且不超配额 |
| 5 | 日志无凭证 | 跑完 1/3/4 后 grep 日志 | 无 `AKID`/`dpt_`/`sk-`/`SecretKey` |
| 6 | 返回值无敏感信息 | 检查 7 个工具的返回样本 | 无 instanceId/token/内网地址 |

补充用例：

- 并发同会话 singleflight：并发 10 个 navigate 到同一 sessionKey，只应产生 1 个 `startPromise`。
- 幂等停止：对已停止实例重复 Stop，返回成功不抛错。
- 脱敏自检：注入伪造凭证跑全流程，断言 stderr 与返回值无泄漏。

实际执行结果：`acceptance.mjs` 11/11（含 10 并发 `peak=10`）、`test-lifecycle.mjs` 5/5、`test-stdio.mjs` 6/6。

---

## 17. 风险登记

| ID | 风险 | 概率 | 影响 | 应对 | 现状 |
|---|---|---|---|---|---|
| R1 | 部署入口不支持 WSS | 中 | 高：路线 A 失效 | 探针 P1；失败切兜底 | **已发生**，切路线 B |
| R2 | 两层 Token 无法对齐 | 中 | 高：CDP 鉴权失败 | 实例 Token + `X-Access-Token` | 已验证可行 |
| R3 | Affinity 无法稳定绑定 | 中 | 高：状态丢失 | 进程内会话↔实例一对一 | **已发生**，绕开亲和 |
| R4 | PAUSE 实例无法主动回收 | 高 | 中：配额耗尽 | `RB_MAX_PAUSED` 淘汰最久未用 + TTL | 已实现 |
| R5 | 长时间持有 CDP 导致实例常驻 | 高 | 高：违背随用随关 | 本地 90s idle 断开 + 300s TTL | 已实现 |
| R6 | 地域限制误用 | 中 | 中：创建失败 | 只在上海/香港创建 | 已核实 |
| R7 | Beta 参数变更 | 中 | 中：脚本失效 | 参数集中在 `config.ts` | 持续关注 |
| R8 | 单进程 stdio 多 Agent 串扰 | 中 | 中：页面互相踩 | 多 Agent 各起进程 | README 已注明 |

---

## 18. 实施里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 探针：亲和 / 数据面 / 生命周期 / 暂停恢复 | 完成，结论见 §0.1 |
| M1 | 骨架：stdio + HTTP 双传输 + 工具注册 + 配置 | 完成 |
| M2 | 鉴权：环境变量/CSV + AssumeRole + Token 仅内存 | 完成 |
| M3 | 实例后端：start / resume / attach / singleflight / idle | 完成 |
| M4 | 浏览器操作：7 工具齐 | 完成 |
| M5 | 一键部署脚本 + 可选镜像 | 完成 |
| M6 | 脱敏 + 错误归一 + 验收 5/6 | 完成 |
| M7 | 优雅退出 + TTL 兜底 | 完成 |
| M8 | 验收全跑 + README + 成本说明 | 完成 |

---

## 19. 已决事项

原「待确认项」已全部落定：

1. 实现语言：**TypeScript / Node 20，ESM**。
2. `persistState`：**作为 `browser_navigate` 可选参数**，默认 false。
3. `browser_extract` 返回：**`{ok, data}`**，列表/单对象两种形态，不做 markdown 双返回。
4. streamable HTTP：**已实现**，`RB_TRANSPORT=HTTP` 开启。
5. 49983 不对外暴露，仅容器内 envd 使用。
6. CAM 最小权限：控制面只需 AGS 工具/实例相关 Action 与 STS `AssumeRole`，建议在控制台按实际调用核对一次。

---

## 20. 参考文档

- [弹性部署(beta) 概述](https://cloud.tencent.com/document/product/1814/137850)
- [创建并访问弹性部署](https://cloud.tencent.com/document/product/1814/137829)
- [配置弹性伸缩与空闲生命周期](https://cloud.tencent.com/document/product/1814/137830)
- [配置会话亲和](https://cloud.tencent.com/document/product/1814/137831)
- [CreateDeployment](https://cloud.tencent.com/document/api/1814/136841)
- [AcquireDeploymentToken](https://cloud.tencent.com/document/api/1814/136842)
- [浏览器操作](https://cloud.tencent.com/document/product/1814/123852)
- [Windows Agent Aren 端口与访问](https://cloud.tencent.com/document/product/1814/139439)
- [创建沙箱工具（CLI）](https://cloud.tencent.com/document/product/1814/132210)
- [StartSandboxInstance](https://cloud.tencent.com/document/api/1814/124816)
- [AcquireSandboxInstanceToken](https://cloud.tencent.com/document/api/1814/124818)
- [DescribeSandboxInstanceList](https://cloud.tencent.com/document/api/1814/124817)
- [停止与超时](https://cloud.tencent.com/document/product/1814/132338)
- [envd 构建 AGS 自定义沙箱镜像](https://cloud.tencent.com/document/product/1814/137275)