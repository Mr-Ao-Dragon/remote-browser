/**
 * 探针 13b：CAM 写权限判定（全部无副作用：只对不存在的角色操作）
 */
const { makeClient } = require("../lib/tc-generic");

const errInfo = (e) => ({
  code: (e && e.code) || "UNKNOWN",
  message: String((e && e.message) || e).slice(0, 200),
});

const CASES = [
  ["AttachRolePolicy", { PolicyId: 1, AttachRoleName: "rb-nonexistent-probe-xyz" }],
  ["ListAttachedRolePolicies", { RoleName: "rb-nonexistent-probe-xyz", Page: 1, Rp: 10 }],
  ["GetRole", { RoleName: "rb-nonexistent-probe-xyz" }],
  ["DescribeRoleList", { Page: 1, Rp: 10 }],
  ["ListPolicies", { Scope: "Local", Page: 1, Rp: 10 }],
];

(async () => {
  const cam = makeClient("cam", "2019-01-16", "ap-shanghai");
  const out = [];
  for (const [action, params] of CASES) {
    try {
      const r = await cam.request(action, params);
      out.push({ action, ok: true, sample: JSON.stringify(r).slice(0, 200) });
    } catch (e) {
      out.push({ action, ok: false, error: errInfo(e) });
    }
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});