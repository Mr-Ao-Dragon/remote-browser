# Fix Report - 装进 profile 后 MCP 入口路径算错，dsh 进恢复模式

## Bug 描述

按 `dsh plugin --profile tavern add <repo>/integrations/deepseek-harness` 装好 bundle 后重启 DSH Desktop，插件树加载失败，整个应用进入恢复模式：

```
dsh-plugin-desktop: plugin tree failed to load: failed to apply loader entry include
(cordis:include): failed to apply loader entry remote-browser (dsh-plugin-remote-browser):
remote-browser(dsh): 找不到 MCP Server 入口
C:\Users\aoloong\AppData\Local\DSH-Tavern\data\harness\profiles\tavern\dist\index.js。
先在仓库根目录执行 "npm run build"，或用 RB_MCP_ENTRY / config.entry 指定入口。
```

影响面不是"少一个工具"：插件 `apply()` 抛错会让 cordis 的 include 判定插件树加载失败，dsh 直接起不来。

## 问题根因

默认入口的推导建立在一个只在源码方式下成立的前提上：

```js
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DIST_ENTRY = resolve(HERE, "../../dist/index.js");
```

- 源码 / `--patch` overlay 方式：`HERE` = `<repo>/integrations/deepseek-harness`，`../../dist/index.js` 正好是 `<repo>/dist/index.js`。
- bundle 方式：pnpm 对本地目录依赖做的是**硬链接复制**，插件代码被放进 `profiles/<name>/node_modules/dsh-plugin-remote-browser/`（`ls -la` 显示 link count 2，不是软链）。`import.meta.url` 的 realpath 落在 profile 内，于是 `HERE` = `.../profiles/tavern/node_modules/dsh-plugin-remote-browser`，`../../dist/index.js` 被算成 `.../profiles/tavern/dist/index.js`。

二次伤害来自 `resolveEntry()` 的策略：入口不存在直接 `throw`，而这个"不存在"只是默认猜测值不存在，不代表用户配错了任何东西。

## 官方依据

- `dsh-ref/package/docs/user/develop/basic/publish.zh.md`：profile 目录的 `cordis.patch.yml` 是用户自己的 patch 层，**在每个组合包层之后应用**；patch 行按 `id` 引用条目，可以覆盖 bundle 插入行的 config。
- `@deepseek-ai/dsh-app-boot@0.1.5-rc.2` 的 `lib/index.js`（`profile.js` 段）注释与之吻合："the user's own patch layer, applied after every bundle layer"。
- 同文件 `applyEntryPatches` 的实现：非 `insert` 且带 `id` 的 patch 会对目标条目执行 `target[key] = value`，即 **config 整段替换**；匹配不到只 `warn` 并跳过，不会抛错。

顺带确认：`@deepseek-ai/dsh@0.1.5-rc.2` 的 `dsh-credentials` 发的确实是 `credentials/reference-updated`，上一个修复（事件改名）在这个 runtime 上没有回归。

## 最终方案

| 位置 | 改动 |
|---|---|
| `profiles/tavern/cordis.patch.yml`（用户 profile，立即解封） | 追加 `- id: remote-browser` 覆盖行，`config` 写全 `serverName` / `toolCallTimeoutMs` / `entry` |
| `integrations/deepseek-harness/index.js` | `resolveEntry` 区分"显式配置的入口缺失"（`RB_ENTRY_CONFIGURED_MISSING`）与"默认猜测值缺失"（`RB_ENTRY_DEFAULT_MISSING`），错误信息点明 bundle 装法必须显式写 `entry`；`apply` 只对后者降级——记一条错误日志后跳过挂载，不再把 dsh 拖进恢复模式；把 `buildClientConfig` 前移到 `import dsh-mcp-client` 之前，配置不成立时连依赖都不加载 |
| `integrations/deepseek-harness/selftest.mjs` | 新增 2 条：显式入口缺失必须是配置错误、不能被吞；在临时目录复刻 `profiles/<name>/node_modules/<pkg>` 副本形态，验证默认入口失效时 `apply` 不挂载、只记一条日志 |
| `integrations/deepseek-harness/README.md`、`cordis.patch.yml` 注释 | 写明 bundle 装法必须显式 `entry`，给出可直接粘贴的覆盖段 |

显式配置写错（entry / serverName / toolCallTimeoutMs）仍然抛错——那是真配置错误，静默跳过只会让人以为工具坏了。

## 验证

- `dsh --profile tavern --dump-config`（真实 runtime 0.1.5-rc.2，`DSH_HOME` 指向 `DSH-Tavern/data/harness`）退出码 0，组合结果里该条目被标注 `# == dsh-plugin-remote-browser, patched by ...\profiles\tavern\cordis.patch.yml`，`entry` 为仓库 `dist/index.js`。
- 自检 `node integrations/deepseek-harness/selftest.mjs` → `24/24 passed`。
- 握手冒烟 `node integrations/deepseek-harness/smoke.mjs` → 发现 7 个工具。
- `--dump-config` 输出 grep 不到 `SecretId` / `SecretKey` / `Token`。

## 检查清单

- [x] 对比官方文档：`publish.zh.md` 的层序与按 id 覆盖语义；`dsh-app-boot` 的 `applyEntryPatches` 实现确认 config 是整段替换
- [x] 检查模块：`resolveEntry`（错误分类）、`apply`（降级边界、依赖加载顺序）、`buildClientConfig`（未改动）、`collectEnv`（未改动）、`selftest` 新增用例
- [x] 性能检查：只在启动时多一次 `existsSync` 与一次异常分类；降级分支直接 return，不创建子进程；新增测试的临时目录用 `mkdtemp` + `rm(recursive)` 清理，无残留

## 经验教训

1. 靠 `import.meta.url` 推仓库路径，只在"代码就在仓库里"时成立。包一旦被复制进 `node_modules`，任何基于相对层级的默认值都要重新审视；要么让装法必须显式配置，要么在打包时固化路径。
2. 一个可选集成的初始化失败，不应该让宿主整体不可用。默认值猜错属于"可降级"，用户显式配置写错属于"必须报错"，两者要分开处理。
3. 验证组合结果有现成手段：`dsh --profile <name> --dump-config` 直接把各层 patch 应用后的条目树打出来，比"启动试试"可靠得多，也不会真启动服务或读凭证。