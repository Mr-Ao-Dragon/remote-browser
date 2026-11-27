# 典型任务配方

每个配方都是「最小可用的调用序列」。参数按真实页面替换选择器即可。

## 1. 抓当前页的列表

```text
browser_navigate { "url": "https://example.com/news" }
browser_wait     { "selector": "ul.news-list li" }
browser_extract  {
  "schema": {
    "rowSelector": "ul.news-list li",
    "limit": 50,
    "fields": {
      "title": { "selector": "a", "type": "text" },
      "link":  { "selector": "a", "type": "href" },
      "time":  { "selector": "time", "type": "text" }
    }
  }
}
```

- 行数上限 200，默认 100；页面更多条时需要翻页（见配方 2）。
- `href` 拿到的是原始属性值，相对链接自己拼 base，或把 `url` 一起交给下一步。
- 字段为 `null` 表示页面上没有该元素，不要补默认值。

## 2. 翻页收集多页数据

```text
browser_navigate { "url": "https://example.com/list?page=1" }
（循环，直到没有「下一页」或达到用户要的页数）
  browser_wait    { "selector": "ul.list li" }
  browser_extract { "schema": { ...同上... } }
  browser_click   { "selector": "a.next" }
  browser_wait    { "urlIncludes": "page=", "timeoutMs": 10000 }
```

- 拿不到「下一页」按钮（`selector_timeout`）就停，说明到最后一页。
- 如果站点是无限滚动而不是页码，`browser_click` 点不到加载更多时，可以改为反复 `browser_wait` + `browser_extract`，或直接告诉用户当前实现不支持无限滚动到底。
- 优先用 URL 翻页（`?page=N`）而不是点按钮：更可控，失败也能重来。

## 3. 站内搜索

```text
browser_navigate { "url": "https://example.com" }
browser_type     { "selector": "input[name=q]", "text": "关键词" }
browser_click    { "selector": "button[type=submit]" }
browser_wait     { "selector": ".result-item", "timeoutMs": 20000 }
browser_extract  { "schema": { "rowSelector": ".result-item", "fields": { "title": { "type": "text" }, "url": { "selector": "a", "type": "href" } } } }
```

- `browser_type` 不会按回车，**必须**点提交按钮；站点只认 Enter 时如实告知用户做不到。
- 联想下拉：`browser_type` 后先 `browser_wait` 等 `li.suggestion`，再 `browser_click` 选中项。
- 结果区用 `browser_wait` 等，不要 navigate 完立刻 extract——`domcontentloaded` 不代表数据已渲染。

## 4. 批量打开详情页

```text
1) 先按配方 1 抓列表拿到 link
2) 逐个：
   browser_navigate { "url": "<详情页地址>" }
   browser_wait     { "selector": "h1" }
   browser_extract  { "schema": { "fields": { "title": { "selector": "h1" }, "body": { "selector": ".content" }, "price": { "selector": ".price", "type": "text" } } } }
3) 全部完成后 browser_close
```

- 单对象模式不传 `rowSelector`，字段选择器相对 `document.body`。
- 一次任务里不要开很多并发会话；单会话串行最稳，也最省配额。
- 详情页量大时，先只抓 3–5 个确认 schema 正确，再放开批量。

## 5. 需要登录态的多轮操作

```text
第一轮：
  browser_navigate { "url": "https://example.com/login", "persistState": true }
  browser_type     { "selector": "#user", "text": "..." }
  browser_type     { "selector": "#pass", "text": "..." }
  browser_click    { "selector": "button.login" }
  browser_wait     { "urlIncludes": "/dashboard" }

后续轮次（会话已被空闲暂停也没关系，会自动恢复）：
  browser_navigate { "url": "https://example.com/orders" }
  browser_extract  { ... }
```

- `persistState: true` 让空闲动作变成「暂停」而不是「销毁」，页面与 Cookie 保留。
- 会话仍可能因为进程重启、`browser_close`、超时回收而丢失登录态；遇到跳回登录页就重新登录，不要循环重试。
- 用户的账号密码应当由用户提供，不要在回复里回显。

## 6. 提交前核对

```text
browser_type      { "selector": "#amount", "text": "100" }
browser_screenshot{ "fullPage": false }
（确认填写正确后）
browser_click     { "selector": "button.submit" }
browser_wait      { "text": "提交成功", "timeoutMs": 15000 }
```

- 提交类操作不可回滚，点击前用截图确认；点击后失败也**不要立刻再点一次**，先用 `browser_wait` / `browser_screenshot` 判断是否已经生效。

## 7. 元素找不到时的排查顺序

1. `browser_screenshot { "fullPage": false }` 看页面实际长什么样（是不是登录墙、验证码、错误页、弹窗遮罩）。
2. `browser_wait { "text": "关键字" }` 确认页面内容是否已加载。
3. `browser_extract { "schema": { "fields": { "html": { "selector": "body", "type": "html" } } } }` 看真实 DOM 结构（数据量大时只取容器，例如 `main`、`.list`）。
4. 换更稳的选择器：优先 `data-*` 属性、`aria-label`、稳定的 class，避免随机哈希 class。
5. 仍失败就报告：给出 `code`、你试过的选择器、截图结论，不要无限换选择器硬试。

## 8. 收尾

- 任务完成 → `browser_close`。
- 还要继续用同一登录态 → **不要** close，让会话暂停保留。
- 用户只是问一句页面内容 → `browser_navigate` + `browser_extract` 就够，不必截图。