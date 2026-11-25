# Fix Report - 设置变更不触发 MCP 子进程重连

## Bug 描述

在 dsh 设置页保存凭证或运行参数后，界面提示「已保存，插件会自动重启 MCP 子进程使新配置生效」，但实际不生效：MCP 子进程仍是旧环境变量，必须重启 dsh 才生效。

发现方式：GitHub PR #1 上 `chatgpt-codex-connector` 的自动 review，指认 `integrations/deepseek-harness/index.js:203` 订阅的事件名不对。

## 问题根因

host 半边监听的是 `credentials/updated`。dsh 0.2.2-rc.5 中该事件已改名：

- `credentials/reference-updated (ref)` —— 引用空间（`TC_SECRET_ID` 这类环境变量形状的引用）的 set / unset / 外部编辑
- `credentials/record-updated (key)` —— record 空间，与引用空间键语法互斥

旧名在当前版本不会被发出，监听器永远不执行，所以 `fiber.update()` 一次都没被调用过。

错误来源是我最初参考的 `@deepseek-ai/dsh-credentials@0.0.1-rc.1` 包 README，里面写的确实是 `credentials/updated`。那是 rc.1 一代的 API；实际运行的是 `@deepseek-ai/dsh@0.2.2-rc.5`，`grep` 它的文档里完全没有 `credentials/updated` 这个名字。

## 尝试记录

### 尝试 1：以 `@deepseek-ai/dsh-credentials@0.0.1-rc.1` 的 README 为准

- 结果：失败（误导）
- 原因：该包 0.0.1-rc.1 的 README / `lib/types/index.d.ts` 里事件名是 `credentials/updated`，看着完全自洽；但版本与运行时不是同一代，名字已经变了。本地 selftest 用 fake ctx 无条件接住任意事件名，等于把实现里的错名字复制进测试，永远 PASS。

### 尝试 2：按 0.2.2-rc.5 官方文档改名

- 结果：成功
- 原因：`dsh-ref/package/docs/subsystems/credentials.md`（= `@deepseek-ai/dsh@0.2.2-rc.5`，由 `gen-cordis-catalog.ts` 从源码生成）明确声明
  `'credentials/reference-updated'(ref: CredentialRef): void`，触发时机为 `set` / `unset` / 存储中观察到的外部编辑。全仓库 `grep credentials/updated` 在 0.2.2 下零命中，确认没有兼容别名。

## 最终方案

| 文件 | 改动 |
|---|---|
| `index.js` | `ctx.on("credentials/updated", …)` → `ctx.on("credentials/reference-updated", …)`，并注明代际差异 |
| `selftest.mjs` | fake ctx 只在事件名为 `credentials/reference-updated` 时交付监听器，同时记录 `subscribedEvent` 并断言其值 |
| `README.md` | 事件名更新，注明 rc.1 时代叫 `credentials/updated` |

自检结果：`22/22 passed`。修复后若再把名字写错，`应订阅 dsh 0.2.x 的凭证变更事件` 这条断言会直接失败。

## 检查清单

- [x] 对比官方文档：`dsh-ref/package/docs/subsystems/credentials.md`（0.2.2-rc.5，源码生成，含 `credentials/reference-updated` / `credentials/record-updated` 定义）；对照 `@deepseek-ai/dsh-credentials@0.0.1-rc.1` README 确认旧名出处
- [x] 检查模块：`apply`（事件订阅与 debounce）、`readCredentialEnv`（引用读取与异常吞掉）、`collectEnv`（五层优先级）、`selftest` 的 fake ctx、`client.js`（保存后只调 `credentials.describe`，不依赖事件，无需改动）
- [x] 性能检查：监听器为 O(1) 的 `CREDENTIAL_REFS.includes` 过滤；300ms debounce 合并连点；`ctx.effect` 卸载时清除定时器，无监听器泄漏；事件频率受用户操作限制，无放大风险

## 经验教训

1. 参考包版本必须与运行时版本对齐。同一个 major 下的 rc 号不同，事件名/API 名都可能改，拿旧包 README 写代码本质上是在猜。
2. 用 fake ctx 做单测时，不能让 fake 无条件接受任意事件名——那会把实现里的错误固化进测试。要么断言事件名，要么从真实类型声明里取常量。
3. 外部 review（Codex）的价值正在这里：它读的是仓库里真实声明的 surface，能抓出「本地测试自洽但与运行时不符」这类错。