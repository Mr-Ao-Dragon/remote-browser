/**
 * 探针 12：权限能力矩阵（只读）
 * 目标：确认当前 CAM 子账号到底能做什么，为“镜像仓库 + RoleArn”找到可行路径。
 * 只读调用，不创建资源。
 */
const { makeClient } = require("../lib/tc-generic");

const errInfo = (e) => ({
  code: (e && e.code) || "UNKNOWN",
  message: String((e && e.message) || e).slice(0, 220),
});

const CASES = [
  ["cam", "2019-01-16", "GetRole", { RoleName: "ags-ccr-full" }],
  ["cam", "2019-01-16", "GetRole", { RoleName: "TCR_QCSRole" }],
  ["cam", "2019-01-16", "GetUser", { Name: "100047758317" }],
  ["cam", "2019-01-16", "ListPolicies", { Rp: 5, Page: 1 }],
  ["tcr", "2019-09-24", "DescribeInstances", {}],
  ["tcr", "2019-09-24", "DescribeNamespacePersonal", { Namespace: "library" }],
  ["tcr", "2019-09-24", "DescribeRepositoryPersonal", { RepoName: "library/python" }],
  ["scf", "2018-04-16", "ListFunctions", { Limit: 1 }],
  ["vpc", "2017-03-12", "DescribeVpcs", { Limit: 1 }],
];

(async () => {
  const out = [];
  for (const [service, version, action, params] of CASES) {
    const c = makeClient(service, version, "ap-shanghai");
    const t0 = Date.now();
    try {
      const r = await c.request(action, params);
      out.push({
        action: `${service}:${action}`,
        ok: true,
        ms: Date.now() - t0,
        sample: JSON.stringify(r).slice(0, 260),
      });
    } catch (e) {
      out.push({
        action: `${service}:${action}`,
        ok: false,
        ms: Date.now() - t0,
        error: errInfo(e),
      });
    }
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});