/**
 * 探针 15：盘点当前子账号的 IAM 可读范围与自身策略
 */
const { makeClient } = require("../lib/tc-generic");

const errInfo = (e) => ({
  code: (e && e.code) || "UNKNOWN",
  message: String((e && e.message) || e).slice(0, 200),
});

const CASES = [
  ["ListUsers", { Page: 1, Rp: 20 }],
  ["ListGroups", { Page: 1, Rp: 20 }],
  ["ListAttachedUserPolicies", { SubUin: "100047758317", Page: 1, Rp: 50 }],
  ["ListPolicies", { Scope: "QCS", Page: 1, Rp: 50 }],
  ["ListAccessKeys", {}],
  ["DescribeSafeAuthFlag", {}],
];

(async () => {
  const cam = makeClient("cam", "2019-01-16", "ap-shanghai");
  const out = [];
  for (const [action, params] of CASES) {
    try {
      const r = await cam.request(action, params);
      out.push({ action, ok: true, sample: JSON.stringify(r).slice(0, 700) });
    } catch (e) {
      out.push({ action, ok: false, error: errInfo(e) });
    }
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});