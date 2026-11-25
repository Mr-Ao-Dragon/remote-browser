# remote-browser

给 LLM Agent 用的「随用随关」浏览器沙箱 MCP Server。底层跑在腾讯云 Agent Runtime（AGS）上，Agent 只看到 7 个普通网页操作工具，**看不到沙箱实例、Token、会话和生命周期**。

```
Agent ──stdio / streamable HTTP──> remote-browser (本机进程)
                                      │
                                      ├─ 控制面 SDK（CAM AK/SK → 可选 AssumeRole）
                                      │    StartSandboxInstance / Pause / Resume / Stop
                                      │    AcquireSandboxInstanceToken（只存内存）
                                      │
                                      └─ Playwright over CDP
                                           公网 wss://9000-{instance}.{region}.tencentags.com/...
                                           Header: X-Access-Token
                                      │
                                      ▼
                                  AGS 浏览器沙箱实例（Chromium + nginx）
```

## 为什么不是弹性部署

原设计走「弹性部署 + 会话亲和」，实测被否：

| 假设 | 实测结果 |
|---|---|
| 亲和 `EXCLUSIVE` / `STRICT` 能把会话固定到同一实例 | 恒返回 409 `affinity_conflict`，预热池也无效 |
| `BEST_EFFORT` 可替代 | 同一 affinity 值仍落到不同实例，页面状态丢失 |
| 部署入口可直接拿公网 CDP | 返回 `webSocketDebuggerUrl` 指向 `.internal.tencentags.com`，公网不可达 |

所以实现采用**实例直连**：MCP Server 自己管 `Start → Token → CDP → Pause/Resume/Stop`。实例 ws 是公网地址，Playwright 可直连。细节与实测数据见 [docs/implementation-plan.md](docs/implementation-plan.md) §0.1。

## 前置条件（换账号 / 换机器必看）

代码本身不绑定账号、地域或既有资源，所有外部依赖都能通过环境变量替换。但下面几项属于**账号侧前提**，缺一项就跑不通：

| 项 | 说明 |
|---|---|
| AGS 服务已开通 | 目标账号需具备 Agent Runtime 沙箱能力（Beta 需申请）；未开通时控制面直接报无权限/不支持 |
| 地域可用 | `TC_REGION` 只能是已开放的地域，实测 `ap-shanghai` / `ap-hongkong` |
| CAM 权限 | 控制面账号或扮演角色需具备 `ags:DescribeSandboxToolList`、`CreateSandboxTool`、`DeleteSandboxTool`、`DescribeSandboxInstanceList`、`StartSandboxInstance`、`AcquireSandboxInstanceToken`、`PauseSandboxInstance`、`ResumeSandboxInstance`、`StopSandboxInstance`、`UpdateSandboxInstance`；启用 AssumeRole 时还需要 `sts:AssumeRole` |
| 镜像可达 | 默认用官方公共镜像 `ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest`，不需要自有仓库；换成自建镜像时同时设 `RB_IMAGE` 并确保 AGS 可拉取 |
| 配额 | 工具 10 / 实例 50 / 暂停 20 是实测默认值，不同账号可能不同；代码里的 `RB_MAX_TOOLS` / `RB_MAX_SESSIONS` / `RB_MAX_PAUSED` 应不超过实际配额 |
| Node.js | `>= 20`（实测 24.18）；依赖由 `package-lock.json` 锁定 |

依赖锁定在 `registry.npmmirror.com`。如果目标环境只能用官方源，先执行一次
`npm install --package-lock-only --registry=https://registry.npmjs.org` 再 `npm ci`，避免 lock 里的地址不可达。

## 快速开始

```bash
npm ci
npm run build

# 1) 配好控制面凭证（二选一）
export TC_SECRET_ID=...
export TC_SECRET_KEY=...
# 或：export TC_CRED_FILE=~/Downloads/SecretKey.csv

# 2) 直接启动，首次调用时才创建沙箱工具与实例
npm start
```

MCP 客户端（Claude Desktop / Cursor 等）配置：

```json
{
  "mcpServers": {
    "remote-browser": {
      "command": "node",
      "args": ["/abs/path/remote-browser/dist/index.js"],
      "env": {
        "TC_REGION": "ap-shanghai",
        "RB_TRANSPORT": "STDIO"
      }
    }
  }
}
```

凭证不要写进这个文件，放本机环境变量或 `TC_CRED_FILE` 指向的文件里。

工具默认**懒创建**：启动阶段不占配额，第一次 `browser_navigate` 时才按 `RB_TOOL_NAME` 查找或创建。要控制回收：

```bash
RB_TOOL_IDLE_MS=3600000   # 工具空闲 1 小时后删除，下次调用自动重建
RB_TOOL_DELETE_ON_EXIT=1  # 进程退出时删除本进程创建的工具
```

这两项只作用于本进程创建的工具；`RB_TOOL_ID` 指定或复用的同名工具一律不删。

如果希望预热（启动前就建好工具、首次调用更快），仍可跑 `node scripts/deploy.cjs` 拿到 `RB_TOOL_ID` 再启动。实测懒创建首次调用多花约 5s（建工具到 ACTIVE 约 4–5s，之后照常起实例约 3.5s）。

## 工具面（7 个，固定不变）

| 工具 | 参数 | 返回 |
|---|---|---|
| `browser_navigate` | `url`、可选 `persistState` | `{ok, url, title, status, tookMs}` |
| `browser_click` | `selector`、可选 `timeoutMs` | `{ok, url, title}` |
| `browser_type` | `selector`、`text`、可选 `timeoutMs` | `{ok, value}` |
| `browser_screenshot` | 可选 `fullPage` | PNG 图片 + 元数据（超过 8MB 报错） |
| `browser_extract` | `schema{rowSelector?, fields, limit?}` | `{ok, data}` |
| `browser_wait` | `selector` / `text` / `urlIncludes` 至少一个、可选 `timeoutMs` | `{ok, matched, elapsedMs, url, title}` |
| `browser_close` | 无 | `{ok, closed}` |

`browser_extract` 的字段类型：`text | html | href | src | value | attribute | count | exists`，`attribute` 需配 `attr`。

示例：

```json
{ "url": "https://cloud.tencent.com", "persistState": true }
```

```json
{
  "schema": {
    "rowSelector": "ul.list li",
    "limit": 20,
    "fields": {
      "name": { "selector": "a", "type": "text" },
      "link": { "selector": "a", "type": "href" }
    }
  }
}
```

错误统一为 `{ok:false, code, message}`，`code` 取值：`invalid_argument`、`unsupported_url`、`credential_missing`、`credential_invalid`、`quota_exceeded`、`sandbox_start_timeout`、`sandbox_not_ready`、`browser_disconnected`、`selector_timeout`、`navigation_failed`、`tool_unavailable`、`sandbox_error`、`internal_error`。`message` 已脱敏。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TC_REGION` | `ap-shanghai` | Beta 公有云仅上海 / 香港 |
| `TC_SECRET_ID` / `TC_SECRET_KEY` | 空 | 控制面凭证；为空时读 `TC_CRED_FILE` |
| `TC_CRED_FILE` | `~/Downloads/SecretKey (1).csv` | CSV 需含 SecretId / SecretKey 列 |
| `TC_ROLE_ARN` | 空 | 配置后先 AssumeRole 再调 AGS |
| `RB_TOOL_ID` | 空 | 固定使用指定工具；为空则按需创建 |
| `RB_TOOL_NAME` | `remote-browser` | 按需创建 / 复用的工具名 |
| `RB_TOOL_IDLE_MS` | `0` | 工具空闲多久后删除，`0` 表示不回收；只删本进程创建的工具 |
| `RB_TOOL_DELETE_ON_EXIT` | `0` | `1` 时进程退出删除本进程创建的工具 |
| `RB_TOOL_TIMEOUT` | `5m` | 工具默认超时，**最小 300s** |
| `RB_INSTANCE_TIMEOUT` | `5m` | 单实例 TTL，续期也用它 |
| `RB_SANDBOX_PORT` | `9000` | 沙箱内 nginx 端口（`/cdp` 反代到 9222） |
| `RB_IDLE_MS` | `90000` | 空闲多久回收 |
| `RB_IDLE_ACTION` | `PAUSE` | 非 `persistState` 会话的空闲动作：`PAUSE` / `STOP` |
| `RB_TTL_RENEW_MS` | `120000` | 活跃会话续期间隔 |
| `RB_MAX_SESSIONS` | `10` | 进程内会话上限 |
| `RB_MAX_TOOLS` | `10` | 工具数量自我保护（地域配额 10） |
| `RB_MAX_PAUSED` | `20` | 暂停实例上限（地域配额 20） |
| `RB_TRANSPORT` | `STDIO` | `STDIO` / `HTTP` |
| `RB_HTTP_PORT` / `RB_HTTP_HOST` | `8787` / `127.0.0.1` | HTTP 模式监听地址，路径 `/mcp`，健康检查 `/health` |
| `RB_LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARN` / `ERROR`，日志写 stderr |

## 生命周期

```
首次调用 ──> 工具不存在？按需创建(≈4s) ──> StartSandboxInstance(≈3.5s) ──> Token ──> CDP ──> Playwright
                    │
                    ├── 空闲 90s ──> PauseSandboxInstance{Memory:true} ──> PAUSED（页面/登录态保留）
                    │                        └── 上限 20 时淘汰最久未用
                    ├── browser_close / 进程退出 ──> StopSandboxInstance（幂等）
                    └── 工具空闲 N 分钟 且 无任何实例 ──> DeleteSandboxTool（可选，需显式开启）
```

工具与实例是两级资源：工具只定义镜像、启动命令、端口和配额，本身不跑页面；实例才计费。删除工具前会同时检查本地会话和云端实例列表，任一非空就跳过本轮。

- **singleflight**：同一会话并发请求只触发一次启动/恢复。
- **per-session 串行**：同一会话内的点击/导航排队执行，不互相踩踏。
- **TTL 安全网**：实例 `Timeout=300s`，进程被 `kill -9` 后最坏 5 分钟自动 `STOPPED`（`StopReason=timeout`）。
- **续期**：活跃会话每 120s 调 `UpdateSandboxInstance`，避免长任务被 TTL 打断。非持久实例支持，持久实例会返回 `UnsupportedOperation`，忽略即可。
- **优雅退出**：SIGINT / SIGTERM / uncaughtException 时并发停止所有实例，失败的只计数并记日志。

## 安全

- 控制面凭证只从环境变量或 CSV 读，不落盘、不进日志，也不出现在工具返回值。
- 实例 Token 只在内存，随实例销亡；不作为服务长期凭证。
- 日志出口统一过 `redact()`：`sit_` / `dpt_` / `AKID` / JWT / `.internal.tencentags.com` / `{port}-{id}.…tencentags.com` / 裸实例 ID（32 位以上）全部打码。
- 错误信息截断到 400 字符并脱敏后才返回给 Agent。
- `browser_navigate` 只接受 `http` / `https`。

## 验收

```bash
# HTTP 模式（先以 RB_TRANSPORT=HTTP RB_HTTP_PORT=8791 npm start 启动）
RB_URL=http://127.0.0.1:8791/mcp RB_TOOL_ID=sdt-xxx RB_CONCURRENCY=10 node scripts/acceptance.mjs

# stdio 模式（脚本自己拉起 dist/index.js）
node scripts/test-stdio.mjs                    # 懒创建 + 退出回收（自建自删工具）
RB_TOOL_ID=sdt-xxx node scripts/test-stdio.mjs # 固定工具

# 生命周期：懒启动 / 空闲暂停 / 恢复保留状态 / close 释放
RB_TOOL_ID=sdt-xxx RB_IDLE_WAIT=25000 node scripts/test-lifecycle.mjs
```

最近一次结果：acceptance 11/11（10 并发 `peak=10`）、stdio 7/7（含懒创建与退出回收）、lifecycle 5/5，日志 grep 无凭证。

## 自定义镜像

默认直接用官方镜像 `ccr.ccs.tencentyun.com/ags-image/sandbox-browser:latest`，不需要构建。要补中文字体 / 时区时用 [docker/Dockerfile](docker/Dockerfile) 基于官方镜像加一层，然后 `RB_IMAGE=<你的镜像> node scripts/deploy.cjs`。

Chromium 不会自动启动，由工具的 `Args` 启动脚本（`src/sandbox/bootstrap.ts` 的 `BROWSER_BOOTSTRAP`）拉起，带崩溃重启循环。9000 端口 nginx 把 `/cdp` 反代到 `127.0.0.1:9222`，9222 不对外暴露。

## 接入 DeepSeek Harness（dsh）

[integrations/deepseek-harness](integrations/deepseek-harness/README.md) 是一个标准 dsh bundle（`dsh.bundle` → `cordis.patch.yml`），内部只做入口定位、`TC_*`/`RB_*` 显式转发，再挂载 dsh 官方的 `@deepseek-ai/dsh-mcp-client`。工具在 dsh 中显示为 `mcp__remote_browser__browser_navigate` 这类名字。

同一个包还带浏览器半边（`dsh.client` → `client.js`）：装好后 dsh 设置弹窗里多出「远端浏览器」标签页，可以直接填 `TC_SECRET_ID` / `TC_SECRET_KEY` 和地域、空闲回收等运行参数。值落在 dsh 凭证库里，保存后 host 半边用 `fiber.update()` 重连 MCP 子进程，不用重启 dsh。

核心代码零改动，MCP 仍是唯一接口：其它 Agent 工具直接接 MCP Server，不需要再写一层适配。

```bash
npm run build
node integrations/deepseek-harness/selftest.mjs   # 22 项，离线自检（含 client 产物与重启逻辑）
node integrations/deepseek-harness/smoke.mjs      # 真实拉起 MCP 子进程，确认 7 个工具被 dsh 发现
```

## 给 Agent 用的 Skill

[skills/remote-browser](skills/remote-browser/SKILL.md) 是一份 Agent Skill，教调用方怎么用这 7 个工具：什么时候该等、`selector` 怎么写、`type` 不按回车、拿到 `null` 代表什么、每种错误码该重试还是该停手。它不含任何凭证或服务端实现，只描述工具面。

装上之后 Agent 在遇到「打开网页 / 抓列表 / 填表提交 / 截图核对」这类请求时会自动加载。安装方式是把整个目录放进宿主机的技能目录：

```bash
# tianxi / Lenovo AIAgent
cp -r skills/remote-browser "$PROGRAMDATA/Lenovo/AIAgent/xlagent/skills/"

# Claude Code / 兼容 Agent Skills 的宿主
cp -r skills/remote-browser ~/.claude/skills/
```

本机也可以直接建目录联接，避免两处副本漂移：

```bash
cmd //c mklink /J "%PROGRAMDATA%\Lenovo\AIAgent\xlagent\skills\remote-browser" "%CD%\skills\remote-browser"
```

工具名带宿主前缀（如 `mcp__remote_browser__browser_navigate`）时按后缀识别。

## 已知限制

- `Timeout` 实测最小 300s，空闲回收的最小粒度受限于本地 `RB_IDLE_MS`，与 TTL 无关。
- 一个实例同时只允许一条 CDP 连接（`MaxInstanceRequestConcurrency=1`），所以会话与实例是一对一。
- 持久工具不支持改 TTL，也不能 `UpdateSandboxInstance` 续期；本实现用非持久工具。
- 持久工具会保持一个常驻实例（`StopSandboxInstance` 后会自动拉起），长期存在会持续计费；确认不用时应删除工具而不是反复停止实例。本实现创建的始终是非持久工具。
- 懒创建模式下首次调用总耗时约 7–9s（建工具 + 起实例）；预热后回到 3–4s。
- 按 `RB_TOOL_NAME` 复用是"看到同名就复用"，不校验配置。若该名字已被其他用途的同名工具占用（镜像/端口不同），表现为 CDP 连不上；换一个独立的 `RB_TOOL_NAME` 或直接指定 `RB_TOOL_ID`。
- 工具回收依赖"无本地会话 + 云端无活跃实例"两个条件同时满足；长期挂着的 `persistState` 暂停会话会阻止回收，直到 `RB_TOOL_IDLE_MS` 把闲置暂停会话也停掉。
- stdio 模式下所有调用共享 `sessionId=local`，多个 Agent 要各起一个进程。

## 目录

```
src/
  index.ts              入口：组装依赖、信号处理、选择传输
  config.ts             环境变量配置
  errors.ts             RbError / 错误码收敛
  logger.ts             结构化日志（脱敏）
  redact.ts             凭证与内网地址打码
  ags/client.ts         控制面客户端 + 凭证解析 + AssumeRole
  sandbox/
    bootstrap.ts        沙箱内 Chromium 启动脚本
    provisioner.ts      沙箱工具定位/创建/删除
    tool-lease.ts       工具按需租约：懒创建 / singleflight / 空闲与退出回收
    instances.ts        实例控制面（start/resume/pause/stop/renew）
    connector.ts        CDP 发现 + Playwright 连接
    runtime.ts          实例 + 连接组合
  session/manager.ts    会话映射 / singleflight / 空闲回收 / 优雅退出
  mcp/
    server.ts           McpServer 构建
    stdio.ts            stdio 传输
    http.ts             streamable HTTP 传输
    tools/              7 个工具，一个文件一个工具 + shared.ts
scripts/
  deploy.cjs          预热：创建/复用沙箱工具（可选）
  cleanup.cjs         列出/停止遗留实例、列出/删除工具（写操作需 --yes）
  acceptance.mjs      HTTP 验收（11 项）
  test-lifecycle.mjs  生命周期验收（5 项）
  test-stdio.mjs      stdio 冒烟（7 项，支持懒创建自建自删）
  probes/             历史路线探针（含旧资源 ID，仅供查阅）
docker/Dockerfile     可选的自定义镜像
integrations/
  deepseek-harness/   dsh 适配层：bundle + 设置标签页 + 自检（核心零改动）
skills/
  remote-browser/     Agent Skill：7 个工具的使用说明、错误应对与任务配方
docs/
  implementation-plan.md  实施方案与实测结论
  cost.md                 成本构成与估算方法
```

## 成本

见 [docs/cost.md](docs/cost.md)。