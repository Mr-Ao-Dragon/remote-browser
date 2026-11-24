# remote-browser × DeepSeek Harness (dsh)

把本仓库的 MCP Server 原样挂进 [DeepSeek Harness](https://www.deepseek.com/harness/) 的适配层。

- **核心零改动**：`src/` 不动，MCP 仍是唯一接口，Claude Code / Codex / 自研 harness 继续直接接 MCP。
- **本包只做适配**：定位入口、转发环境变量、挂载 dsh 官方的 `@deepseek-ai/dsh-mcp-client`。
- **一个包两半**：`index.js` 是 host 半边（挂 MCP 子进程），`client.js` 是浏览器半边（设置弹窗里的「远端浏览器」标签页）。
- **工具名**：dsh 会把 MCP 工具注册成 `mcp__<serverName>__<rawName>`，默认 `serverName=remote_browser`。

| MCP 工具 | dsh 中看到的工具名 |
|---|---|
| `browser_navigate` | `mcp__remote_browser__browser_navigate` |
| `browser_click` | `mcp__remote_browser__browser_click` |
| `browser_type` | `mcp__remote_browser__browser_type` |
| `browser_screenshot` | `mcp__remote_browser__browser_screenshot` |
| `browser_extract` | `mcp__remote_browser__browser_extract` |
| `browser_wait` | `mcp__remote_browser__browser_wait` |
| `browser_close` | `mcp__remote_browser__browser_close` |

## 前置条件

1. 仓库根目录已构建：`npm run build`（产物 `dist/index.js`，`.gitignore` 里不提交）。
2. 适配层自己的依赖：`cd integrations/deepseek-harness && npm install`（只装 `@deepseek-ai/dsh-mcp-client`，它同时被 dsh 自身依赖）。
3. 控制面凭证可用，任选其一：
   - 在 dsh 设置弹窗的「远端浏览器」标签里填（推荐，见下文）
   - `TC_SECRET_ID` + `TC_SECRET_KEY`
   - `TC_CRED_FILE`（CSV 路径）
   - `TC_ROLE_ARN` + 上面前两者之一（走 AssumeRole）
4. dsh 版本参考：`@deepseek-ai/dsh@0.2.2-rc.5`、`@deepseek-ai/dsh-mcp-client@0.0.1-rc.1`。预览期 API 会变，升级后先跑本包自检。

## 方式 A：作为 bundle 安装

本包在 `package.json` 里声明了：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

所以它是一个标准 dsh bundle。安装到 profile：

```bash
dsh plugin --profile web add /absolute/path/to/remote-browser/integrations/deepseek-harness
dsh plugin --profile web list
dsh web
```

`cordis.patch.yml` 只插入一行，默认值如下；你可以在自己的 patch 层按 `id: remote-browser` 整段覆盖：

```yaml
- insert:
    - id: remote-browser
      name: 'dsh-plugin-remote-browser'
      config:
        serverName: remote_browser
        toolCallTimeoutMs: 240000
```

## 方式 B：不安装，用 overlay 直接加载

先 `cd integrations/deepseek-harness && npm install`，然后写一个 overlay（路径换成你的实际绝对路径）：

```yaml
- insert:
    - id: remote-browser
      name: '/absolute/path/to/remote-browser/integrations/deepseek-harness/index.js'
      config:
        serverName: remote_browser
```

启动：

```bash
dsh web --patch ./my-remote-browser.patch.yml
```

适合本地开发调试；稳定使用建议走方式 A。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `serverName` | `remote_browser` | 工具命名空间，`[A-Za-z0-9_-]{1,32}`；改了工具名会变 |
| `entry` | 仓库 `dist/index.js` | MCP Server 入口绝对路径 |
| `command` | `process.execPath` | 启动子进程的可执行文件 |
| `cwd` | `dist` 的上级目录 | 子进程工作目录 |
| `env` | `{}` | 追加 / 覆盖环境变量 |
| `toolCallTimeoutMs` | `240000` | 单次工具调用超时；首次导航含建工具与起实例，别调太小 |
| `failOnStartupError` | `false` | 初始连接失败是否让 dsh 启动失败 |

也可以不写配置，用 `RB_MCP_ENTRY` 指定入口。

## 环境变量与凭证

`@deepseek-ai/dsh-mcp-client` 会清掉父进程中"看起来像凭证"的变量和所有 `DSH_*`，所以本适配层**显式转发** `TC_*` 与 `RB_*`，其余变量不进入子进程。适配层自己加的三个默认值：

| 变量 | 适配层默认 | 原因 |
|---|---|---|
| `RB_TRANSPORT` | 强制 `STDIO` | mcp-client 用 stdio 握手，HTTP 模式会被覆盖 |
| `RB_TOOL_DELETE_ON_EXIT` | `1` | dsh 正常退出时回收本进程创建的沙箱工具 |
| `RB_TOOL_IDLE_MS` | `600000` | dsh 长驻；10 分钟无人使用就删工具，下次调用重新懒创建 |

凭证只放在启动 dsh 的 shell 环境或密钥服务里，**不要写进 `cordis.patch.yml`**。工具返回值与日志的脱敏仍由核心负责（`src/redact.ts`）。也可以不碰环境变量，直接在 dsh 设置弹窗的「远端浏览器」标签里填，见下节。

## 设置标签页

安装本包后，dsh 设置弹窗会多出一个「远端浏览器」分区（`settings.section` id `remote-browser`），两组字段：

| 分组 | 字段 |
|---|---|
| 云平台凭证 | `TC_SECRET_ID`、`TC_SECRET_KEY` |
| 运行参数 | `TC_REGION`、`RB_IDLE_MS`、`RB_IDLE_ACTION`、`RB_MAX_SESSIONS`、`RB_TOOL_IDLE_MS`、`RB_LOG_LEVEL` |

行为说明：

- **存在哪**：dsh 凭证库（本地 provider 默认写 `$DSH_HOME/.credentials.yaml`），引用名就是环境变量名。密钥不会出现在工具返回值、日志或界面上。
- **只写不读**：`credentials.describe` 只返回"配没配 / 来源层 / 可不可写"，从不返回值本身。所以输入框永远是空的——留空表示保持现值，点「清除」删掉该层的值、回落到默认值。
- **优先级**：内置默认值 < 凭证库 < 进程环境 `TC_*`/`RB_*` < 插件 `config.env` < 强制项 `RB_TRANSPORT=STDIO`。某个变量已经在环境里时，该字段会显示「只读」并禁用输入（dsh 凭证提供方拒绝写入被环境变量遮蔽的引用，避免"写成功但读到的还是旧值"）。
- **什么时候生效**：host 半边监听 `credentials/updated`，去抖 300ms 后用 fiber 的 `update()` 让 MCP 子进程带新环境变量重连，工具名不变。若环境变量层完全覆盖了凭证库，会跳过这次重连。
- **谁能写**：dsh 只接受本机同源页面的写入；用非 loopback 地址打开时界面会显示提示，保存会被拒绝。

> 为什么"运行参数"也放在凭证库里：dsh 的 `settings.*` 只服务白名单命名空间（`locale` / `permission` / `ui-conversation` / `ui-theme` / `ui-onboarding` 和模型 provider 的命名空间），第三方插件注册自己的命名空间会被 `settings-not-exposed` 拒绝，且没有通用的键值读写接口。`credentials.describe/set/unset` 是唯一对第三方插件开放的通用写入通道，所以非密钥项也以"引用"的形式落在这里，代价是读不回来，只能看到"已设置/未设置"，默认值写在 placeholder 里。`serverName`、`toolCallTimeoutMs` 这类影响工具注册的配置仍走 `cordis.patch.yml`，改完重启 dsh。

## 已知限制

- dsh 的多个对话会话共享同一个 MCP 子进程，因此也共享同一个远端浏览器会话（stdio 下固定 `sessionId=local`）。一个会话调 `browser_close` 会影响其它会话。需要隔离时，起多个 dsh 进程或等核心支持多连接会话。
- 首次调用比预热后慢：懒创建约 7–9s，之后约 3–4s。
- dsh 的 `mcp-client` 只桥接 tools，MCP Resources / Prompts 不用。
- dsh 崩溃（非正常退出）时来不及回收工具，需要靠 `RB_TOOL_IDLE_MS` 或 `scripts/cleanup.cjs` 兜底。
- 设置页的「运行参数」读不回原值（见上一节）；需要看清当前值时用环境变量或 `cordis.patch.yml`。
- 设置页依赖本包同时被识别为 `dsh.client` 插件。方式 B（overlay 直接指向 `index.js`）只加载 host 半边，**不会出现标签页**。

## 自检

```bash
node integrations/deepseek-harness/selftest.mjs  # 22 项：入口 / env 分层 / schema / 挂载 / 重启 / client 产物 / package 装配
node integrations/deepseek-harness/smoke.mjs     # 真实拉起 MCP 子进程，确认 7 个工具被发现
```

`selftest` 不依赖 dsh 运行时、不访问腾讯云；`smoke` 需要 `dist/` 与上面的 `npm install`，但只做工具发现，不调用工具，因此也不访问腾讯云（凭证用临时 CSV 占位）。