# 历史探针（仅供查阅，不要直接复跑）

这里记录了路线验证阶段的一次性脚本（探针 00–36）。它们的结论已经固化到
`docs/implementation-plan.md` §0.1，产品代码不依赖本目录。

注意事项：

- 多数脚本把当时的工具 ID 写成 `process.env.TC_TOOL_ID || "sdt-xxxxxxxx"` 的 fallback，
  这些资源已在交付前清理。换账号后直接运行会报 `ResourceNotFound`。
- 需要复跑某个探针时，先用 `node scripts/deploy.cjs`（或控制台）建一个工具，
  再显式传入 `TC_TOOL_ID`，不要依赖 fallback。
- 脚本只用于只读观察或创建临时资源，不属于验收链路。验收用
  `scripts/acceptance.mjs`、`scripts/test-lifecycle.mjs`、`scripts/test-stdio.mjs`。