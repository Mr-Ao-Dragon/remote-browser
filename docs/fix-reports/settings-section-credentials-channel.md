# Fix Report - 设置页「远端浏览器」点开后右侧空白

## Bug 描述

DSH Desktop 设置弹窗左侧能看到「远端浏览器」导航项，点开后右侧内容区完全空白，等待也不会出现表单。宿主日志 `dsh-2026-11-25.log` 最后一次启动（run 1795589503942）没有任何报错，MCP 子进程（PID 137532）也在正常运行——故障只在浏览器半边。

## 问题根因

`client.js` 假设连接句柄有一个 `api` 字段：

```js
const connection = ctx.get("connection");
const api = connection.api;                       // undefined
...
api.credentials.describe({ refs: ALL_REFS })      // TypeError
```

真实句柄来自 `@deepseek-ai/dsh-client-connection/lib/client.js`：

```js
const handle = {
  isLoopback, generation, state, rpc, reconnect, registerGenerationSource, start
};
```

没有 `api`。于是 `api` 是 `undefined`，`refresh()` 在 `useEffect` 里同步抛出 `TypeError: Cannot read properties of undefined (reading 'credentials')`。

React 把 effect 里抛出的错误交给最近的 error boundary；slots 渲染器对每个条目单独设边界：

```js
// @deepseek-ai/dsh-client-ui-renderer/lib/client.js:790
host.reportEntryError(slotKey, entry, error, { abdicate: spec.kind !== "chain" });
```

`SlotCore.reportEntryError` 的语义（`dsh-client-ui-slots/lib/index.js` 注释）：

> Entries retired by an abdicating crash report are excluded from `entriesOfSlot` projections for the rest of their registration's life, while the registration itself stays on the ledger.

于是**导航项还在、内容被永久摘除**——正好是用户看到的现象。

第二个坑在修复过程中发现：cordis 的属性访问会校验注入表，`ctx.remote.credentials` 同时要求注入 `"remote"` 和 `"remote.credentials"`。只注入后者时：

```
cannot get property "remote" without inject
```

`apply` 整体失败 → 连导航项都不会出现。所以两个名字都必须注入（内置 `dsh-client-ui-settings-models` 也是这么写的）。

## 官方依据

- `@deepseek-ai/dsh-client-connection@0.1.5-rc.2` `lib/client.js`：connection handle 的完整字段（无 `api`）。
- `@deepseek-ai/dsh-api-gateway@0.1.5-rc.2` `lib/client.js`：
  - `RemoteNamespaceService` 以 `remote.<namespace>` 注册为 cordis 服务；
  - `invoke()` 走 `connection.rpc.call("/api", endpoint, { args }, signal)`，返回 `{ ok: true, value }` 或 `{ ok: false, error }`；
  - `prepareInvocation` 校验实参个数，`credentials/set` 声明了两个参数。
- `@deepseek-ai/dsh-api-settings-controller@0.1.5-rc.2` `lib/index.js`：
  - `describe(refs)` → `Object.fromEntries([[ref, { configured, source?, writable }]])`；
  - `set(ref, value)`、`unset(ref)`；
  - 引用名文法 `^[A-Za-z_][A-Za-z0-9_]*$`，`TC_SECRET_ID` / `RB_IDLE_MS` 等全部合法。
- `@deepseek-ai/dsh-client-ui-settings-models@0.1.5-rc.2` 是同一通道的官方用例：`inject` 含 `"remote"` 与 `"remote.credentials"`，调用形式为 `ctx.remote.credentials.describe(refs)` / `.set(ref, value)`。
- `@deepseek-ai/cordis@4.0.2` `createTraceable`：`remote.<prop>` 只有在 `ctx.reflect.props["remote.<prop>"]` 存在且 `"remote"` 已注入时才可达。
- `@deepseek-ai/dsh-client-modules@0.1.5-rc.2`：`dsh.client.inject` 决定客户端模块图的到达顺序；包声明它依赖的客户端包即可，缺失的注入项会被静默跳过，不会破坏图。

## 最终方案

| 位置 | 改动 |
|---|---|
| `integrations/deepseek-harness/client.js` | `inject` 改为 `["slots", "connection", "remote", "remote.credentials"]`；删除 `connection.api`，改用 `ctx.remote.credentials.describe(ALL_REFS)` / `.set(ref, value)` / `.unset(ref)`；返回值按 `{ ok, value }` / `{ ok: false, error }` 解析（原实现读的是 `response.result.value.credentials`，两处都不对）；`loopback` 仍读 `connection.isLoopback`，取不到时按本机处理 |
| `integrations/deepseek-harness/package.json` | `dsh.client.inject` 增加 `@deepseek-ai/dsh-api-remotes`，与内置设置页一致 |
| `integrations/deepseek-harness/selftest.mjs` | fake 连接句柄改成真实的 `{ isLoopback }`（不再提供 `api`），补 `remote.credentials` 服务；stub 的 `useEffect` 立即执行并断言 `describe` 收到全部 8 个引用——旧代码在这个测试里会直接抛错。同时断言源码不再出现 `connection.api` |

## 验证

- `node integrations/deepseek-harness/selftest.mjs` → `24/24 passed`（含"分区挂载后读取一次凭证状态、refs 与 CREDENTIAL_REFS 一致"）。
- 用真实 `@deepseek-ai/cordis@4.0.2` 做注入探针：只注入 `remote.credentials` 时 `ctx.remote` 报 `cannot get property "remote" without inject`；同时注入 `remote` 与 `remote.credentials` 后 `ctx.remote.credentials.describe([])` 正常返回 `{ ok: true, value: {} }`。
- 与内置 `dsh-client-ui-settings-models` 的调用形参逐一对照：`describe(refs)`、`set(ref, value)`、`unset(ref)`、返回 `{ ok, value }`。
- profile 中的插件是软链（`profiles/tavern/node_modules/dsh-plugin-remote-browser -> 仓库 integrations/deepseek-harness/`），改完无需重新 `dsh plugin add`；刷新界面或重启 DSH Desktop 后生效。

## 检查清单

- [x] 对比官方文档：connection handle 字段、gateway 的 `invoke` 结果包装、settings-controller 的三个方法签名与 ref 文法、cordis 的注入校验
- [x] 检查模块：`client.js`（inject / 数据通道 / 返回形状 / 错误文案）、`package.json`（模块图声明）、`selftest.mjs`（fake 形状 + effect 执行）
- [x] 性能检查：`describe` 一次批量读 8 个引用（远低于 `MAX_DESCRIBE_REFS = 64`）；保存按字段串行写，失败项保留草稿；无新增轮询或定时器

## 经验教训

1. 上一轮修的是"事件名"，这一轮修的是"句柄字段"——同一个病根：**用自己写错的假设去构造 fake，再让 fake 为假设背书**。selftest 里必须使用真实形状（这次连 `api` 都不给），并且要让 `useEffect` 真的跑一遍，才能抓到"注册成功但一渲染就崩"。
2. slots 的"崩溃退休"语义意味着：导航项还在、内容空白，几乎总是组件渲染/effect 抛错，而不是"没注册"或"没有内容"。看到空白先找客户端异常，不要先怀疑数据。
3. cordis 的 dotted 服务要注入完整路径：访问 `ctx.remote.credentials` 必须同时注入 `"remote"` 与 `"remote.credentials"`，少一个就在属性访问处抛错，而且这个错发生在 `apply` 里，比组件崩溃更难定位（整个分区直接消失）。