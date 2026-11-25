---
name: remote-browser
description: 通过 remote-browser MCP 工具在远端云沙箱的 Chromium 中打开网页、点击、输入、等待、截图和结构化提取数据。当用户要求打开或查看某个网址、抓取网页上的列表/详情/价格/链接、填表并提交、截图核对页面、或完成需要多步点击的浏览器任务时使用；也适用于需要保留登录态的多轮网页操作。不适用于绕过验证码、登录他人账号、批量抓取或访问内网地址。
---

# 远端浏览器（remote-browser）

## 心智模型

远端跑着一个真实的 Chromium，**一个会话只有一页**。工具不带页面句柄，每次调用都作用在该会话的当前页面。

- 页面状态（滚动位置、表单内容、登录 Cookie）在**同一会话内跨调用保留**，所以「打开 → 点击 → 提取」可以分三次调用完成。
- 会话空闲 90s 会被**暂停**（内存保留，下次调用恢复）；`browser_close` 则立即**销毁**实例，下次调用是全新空页面。
- 首次调用要冷启动沙箱，约 7–9s；之后单次操作通常亚秒到几秒。
- 工具返回值里没有实例 ID、Token、内网地址，也不需要你去关心——这是有意设计的。

## 三步上手

1. `browser_navigate` 打开目标页，确认返回的 `title` / `url` 是你要的页面。
2. 用 `browser_wait` 等关键元素出现，再用 `browser_extract` 取结构化数据（需要人眼核对时用 `browser_screenshot`）。
3. 任务结束调 `browser_close` 释放资源。

## 硬规则

1. **每个新任务先 `browser_navigate`。** 不要假设当前页面还停在上一轮的位置——会话可能已被回收。
2. **`url` 只能是 `http` / `https`。** `file://`、`about:`、`chrome://` 一律被拒。
3. **`selector` 按 CSS 写，永远只命中最左/第一个匹配元素。** 工具文档只承诺 CSS；`text=`、`xpath=` 这类 Playwright 专有语法属于未承诺行为，不要依赖。要按文本找元素，先用 `browser_extract` 定位，或改用 `browser_wait` 的 `text` 条件。
4. **点击/输入前先确认元素存在。** 目标元素没渲染出来时直接调 `browser_click` 会拿到 `selector_timeout`；用 `browser_wait` 等它出现更稳。
5. **`browser_type` 是 fill 语义：先清空原值，再写入，不会触发回车键。** 写完需要提交时必须显式 `browser_click` 提交按钮；如果目标站点只认 Enter 键，这个工具体系做不到，要如实告诉用户。
6. **`browser_wait` 同时给多个条件时是「全部满足」，不是「任一满足」。** 只要一个条件即可，就只传一个。
7. **要文字用 `browser_extract`，不要用截图读文本。** 截图只用于核对布局、样式、验证码、图表这类结构化提取拿不到的信息。
8. **任务结束时调 `browser_close`。** 需要跨多轮保留登录态时，第一步 `browser_navigate` 传 `persistState: true`。

## 工具速查

| 工具 | 用途 | 关键参数 | 成功返回 |
|---|---|---|---|
| `browser_navigate` | 打开网址 | `url`（必填）、`persistState` | `{ok, url, title, status, tookMs}` |
| `browser_wait` | 等元素/文本/地址变化 | `selector` \| `text` \| `urlIncludes`（至少一个）、`timeoutMs` | `{ok, matched, elapsedMs, url, title}` |
| `browser_extract` | 按 schema 提结构化数据 | `schema{rowSelector?, fields, limit?}` | `{ok, data}` |
| `browser_click` | 点击元素 | `selector`（必填）、`timeoutMs` | `{ok, url, title}` |
| `browser_type` | 填入文本 | `selector`、`text`（必填）、`timeoutMs` | `{ok, value}` |
| `browser_screenshot` | 截图 | `fullPage` | PNG 图片 + `{ok, bytes, fullPage, url, title}` |
| `browser_close` | 释放本会话实例 | 无 | `{ok, closed}` |

超时默认值：`browser_wait` 15s（上限 60s）、`browser_click` / `browser_type` 15s（1–60s）、内部导航超时 45s。完整参数与返回值见 [references/tools.md](references/tools.md)。

典型任务配方（列表抓取、分页、站内搜索、登录后多轮、提交前核对）见 [references/workflows.md](references/workflows.md)。

## 错误处理

所有失败都是 `{ok:false, code, message}`，`message` 已脱敏。按 `code` 决定动作：

| code | 含义 | 该怎么做 |
|---|---|---|
| `invalid_argument` | 参数不合法（URL 格式、空 selector、空 fields、limit 越界、截图超 8MB） | 修参数后重试，不要原样重发 |
| `unsupported_url` | 不是 http/https | 换公网地址 |
| `selector_timeout` | 元素没找到 / 点不到 / 输入失败 | 先 `browser_wait`，或换更稳的选择器；仍失败就截图看看页面到底长什么样 |
| `navigation_failed` | DNS、证书、连接被拒、45s 未完成 | 检查地址是否公网可达；重试一次仍失败就如实报告 |
| `extract_failed` | schema 与页面结构不匹配 | 重新确认选择器；必要时先 `browser_extract` 取外层 `html` 观察结构 |
| `quota_exceeded` | 并发会话或云端配额到顶 | 不要重试，等已有会话释放；必要时 `browser_close` 其它任务 |
| `sandbox_start_timeout` / `sandbox_not_ready` | 沙箱启动慢或未就绪 | 等几秒重试一次 |
| `browser_disconnected` | CDP 连接断了 | 重试一次（会自动重连/恢复） |
| `credential_missing` / `credential_invalid` | 服务端凭证没配或无效 | 不要重试。告诉用户去补配置：dsh 里是「设置 → 远端浏览器」 |
| `tool_unavailable` | 沙箱工具不可用（权限/配额/配置） | 不要重试。告诉用户这是服务端配置问题 |
| `sandbox_error` / `internal_error` | 云端或内部异常 | 重试一次，仍失败就报告 |

重试原则：**对非幂等操作（点击提交、输入）不要盲目重试**，可能造成重复提交。重试前先用 `browser_wait` 或 `browser_screenshot` 确认页面当前状态。

## 限制（做不到的事，直接告诉用户）

- 一个会话只有一页，没有多标签页、没有新窗口切换。
- 没有 JS 求值、没有 Cookie/Storage 读写、没有网络请求拦截、没有文件上传/下载、没有 PDF 导出。
- 选择器只在主文档里找，不进 iframe 内部。
- 不能按键盘（回车、Tab、快捷键），只能点击和填值。
- 沙箱只能访问公网，内网地址、localhost、公司内网系统访问不到。
- 云端 IP 可能被目标站点风控：出现验证码、人机校验、403 时无法自动通过，应截图并如实说明。
- 没有「拖动」「悬停」「右键菜单」「滚动到指定位置」——`browser_click` 会自动把元素滚进视口，其它滚动需求用 `browser_extract` 配合容器选择器间接实现，做不到就说做不到。
- 单次截图上限 8MB，长页面用 `fullPage: false` 分段核对。
- 工具名在不同宿主里可能带前缀（dsh / Claude Desktop 形如 `mcp__remote_browser__browser_navigate`），按后缀识别即可。

## 输出习惯

- 抓数据时返回**结构化结果**（列表/表格/JSON），不要把整页 HTML 或大段截图原文丢给用户。
- 抓到的字段为 `null` 表示该字段在页面上不存在，不要编造默认值。
- 报告失败时给出 `code` 和你的判断，而不是只说「失败了」。