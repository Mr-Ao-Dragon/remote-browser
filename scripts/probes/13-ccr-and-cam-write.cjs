/**
 * 探针 13：CCR 个人版命名空间盘点 + CAM 写权限判定（无副作用）
 */
const { makeClient } = require("../lib/tc-generic");

const errInfo = (e) => ({
  code: (e && e.code) || "UNKNOWN",
  message: String((e && e.message) || e).slice(0, 240),
});

(async () => {
  const out = {};

  const tcr = makeClient("tcr", "2019-09-24", "ap-shanghai");
  try {
    const r = await tcr.request("DescribeNamespacePersonal", { Limit: 50, Offset: 0 });
    out.namespaces = r;
  } catch (e) {
    out.namespacesError = errInfo(e);
  }

  // 无副作用判定：对不存在的角色做写操作，预期 RoleNotExist（有权限）而不是 Unauthorized（无权限）
  const cam = makeClient("cam", "2019-01-16", "ap-shanghai");
  try {
    const r = await cam.request("AttachRolePolicy", {
      RoleName: "rb-nonexistent-role-probe-xyz",
      PolicyId: 1,
    });
    out.attachProbe = { unexpected: true, result: r };
  } catch (e) {
    out.attachProbe = errInfo(e);
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});