# 工具参考

7 个工具，签名固定。所有工具失败时返回 `{ok:false, code, message}` 且 `isError: true`；成功时返回 JSON 文本（`browser_screenshot` 额外带一张 PNG）。

## browser_navigate

打开一个 http/https 页面。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | 是 | 完整地址，只接受 `http:` / `https:`；其它协议报 `unsupported_url` |
| `persistState` | boolean | 否 | 默认 `false`。`true` 表示任务需要保留登录态/表单，空闲时只暂停不销毁 |

返回：`{ ok: true, url, title, status, tookMs }`

- `waitUntil` 为 `domcontentloaded`，内部超时 45s。
- 超时但页面已经落地时**不报错**，返回当前 `url` / `title`，由调用方判断是否继续等。
- 真正失败（DNS、证书、连接被拒、白屏超时）报 `navigation_failed`。
- `status` 是 HTTP 状态码，可能为 `null`（例如页面没有响应对象）。
- `title` 截断到 300 字符。

## browser_wait

等待条件成立。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `selector` | string | 三选一 | 等该选择器出现（`state: attached`，不要求可见） |
| `text` | string | 三选一 | 等 `document.body.innerText` 包含该文本 |
| `urlIncludes` | string | 三选一 | 等 `location.href` 包含该片段 |
| `timeoutMs` | number | 否 | 500–60000，默认 15000 |

返回：`{ ok: true, matched: true, elapsedMs, url, title }`

- 三个条件都传时**全部满足**才返回，共用同一个 deadline。
- 一个都不传报 `invalid_argument`；超时报 `selector_timeout`。
- 最适合：SPA 路由切换后等新内容、点完按钮等列表刷新、等遮罩消失前的内容加载。

## browser_extract

按声明式 schema 提取数据，在页面内执行，不依赖额外网络请求。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema.fields` | Record<string, FieldSpec> | 是 | 字段名 → 取值规则，不能为空 |
| `schema.rowSelector` | string | 否 | 列表模式：每行选择器。不传则返回单个对象 |
| `schema.limit` | number | 否 | 1–200，列表模式最多返回多少行，默认 100 |

FieldSpec：

| 字段 | 说明 |
|---|---|
| `selector` | 相对选择器。列表模式相对当前行，单对象模式相对 `document.body`；不传表示行本身 / 整个 body |
| `type` | `text`（默认）/ `html` / `href` / `src` / `value` / `attribute` / `count` / `exists` |
| `attr` | `type: "attribute"` 时读取的属性名 |

返回：`{ ok: true, data }`。列表模式 `data` 是数组，单对象模式是对象。

取值细节：

- `text`：`innerText`，取不到回落 `textContent`，`trim()`。
- `html`：`innerHTML`（含标签）。
- `href` / `src` / `attribute`：原始属性值，相对链接**不会**转绝对地址。
- `value`：表单控件当前值，回落 `value` 属性。
- `count`：`field.selector` 命中的子元素数量；没给 selector 时返回 1。
- `exists`：元素存在返回 `true`。
- **元素不存在时所有类型都返回 `null`**（包括 `exists`，不是 `false`）。字段为 `null` 就是「没找到」，不要当成空字符串或 0。

## browser_click

点击第一个匹配的元素。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `selector` | string | 是 | CSS 选择器，首尾空白会被裁剪，空值报 `invalid_argument` |
| `timeoutMs` | number | 否 | 1000–60000，默认 15000，等待元素出现/可点击的最长时间 |

返回：`{ ok: true, url, title }`

- 元素不存在 → `selector_timeout`「未找到匹配的元素」。
- 元素被遮挡、被禁用、动画未结束导致点击失败 → `selector_timeout`「点击失败：…」。
- 点击后最多等 5s 的 `domcontentloaded`，然后返回当前地址与标题。SPA 里地址变得比内容快，需要内容时补一次 `browser_wait`。
- 会先自动把元素滚动进视口。

## browser_type

向第一个匹配的输入框填值。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `selector` | string | 是 | 输入框 CSS 选择器 |
| `text` | string | 是 | 要写入的文本（可为空字符串，用于清空） |
| `timeoutMs` | number | 否 | 1000–60000，默认 15000 |

返回：`{ ok: true, value }`，`value` 是写入后从控件读回的值（读不到为 `null`）。

- 语义是 `fill`：**先清空原值**，不模拟逐字符按键，不触发 Enter。
- 部分前端框架靠 `input` 事件驱动校验，`fill` 会派发该事件；但不派发键盘事件，所以「输入即联想」的下拉可能需要一步 `browser_click` 选具体项。
- 输入框不存在或不可编辑 → `selector_timeout`。

## browser_screenshot

对当前页截图。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `fullPage` | boolean | 否 | 默认 `false`（只截视口）；`true` 截整页 |

返回：PNG 图片内容 + JSON 文本 `{ ok: true, bytes, fullPage, url, title }`。

- 图片超过 8MB 报 `invalid_argument`，改用 `fullPage: false`。
- 用途：核对布局/样式、看验证码、看图表、确认点击结果。**不要用它代替 `browser_extract` 读文本。**

## browser_close

立即释放本会话的远端浏览器实例，无参数。

返回：`{ ok: true, closed: true }`。

- 释放后页面、登录态、表单内容全部丢失；下次任意工具调用会重建一个干净沙箱（重新冷启动）。
- 幂等：重复调用不报错。
- 空闲 90s 只会**暂停**（状态保留），只有 `browser_close` 和进程退出才真正销毁。

## 会话与并发

- 会话标识来自 MCP 的 `sessionId`，stdio 模式下固定为 `local`——即一个进程里的所有调用共享同一页。
- 同一会话内的工具调用**串行排队**，不会互相踩踏；但不要靠排队保证业务顺序，按依赖关系顺序调用更清楚。
- 同一会话的并发启动/恢复走 singleflight，只触发一次。
- 单个实例只允许一条 CDP 连接，因此会话与实例一对一，不同会话不会共享页面。