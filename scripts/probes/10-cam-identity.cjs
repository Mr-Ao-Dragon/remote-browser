/**
 * 探针 10：身份与 CAM 角色盘点
 *  - GetCallerIdentity：确认调用者 UIN / 类型
 *  - DescribeRoleList：看是否已有 AGS 可用的镜像拉取角色
 *  - 顺带查 CCR/tcr 相关角色
 * 只读，不创建资源，不打印凭证。
 */
const { makeClient } = require("../lib/tc-generic");

const errInfo = (e) => ({
  code: (e && e.code) || "UNKNOWN",
  message: (e && e.message) || String(e),
  requestId: (e && e.requestId) || undefined,
});

(async () => {
  const out = {};
  const sts = makeClient("sts", "2018-08-13", "ap-shanghai");
  try {
    const r = await sts.request("GetCallerIdentity", {});
    out.caller = {
      uin: r.Uin,
      appId: r.AppId,
      type: r.Type,
      principalId: r.PrincipalId,
      accountName: r.AccountName,
    };
  } catch (e) {
    out.callerError = errInfo(e);
  }

  const cam = makeClient("cam", "2019-01-16", "ap-shanghai");
  try {
    const r = await cam.request("DescribeRoleList", { Page: 1, Rp: 50 });
    out.roles = (r.List || []).map((x) => ({
      roleName: x.RoleName,
      roleId: x.RoleId,
      description: x.Description,
      consoleLogin: x.ConsoleLogin,
      addTime: x.AddTime,
    }));
  } catch (e) {
    out.rolesError = errInfo(e);
  }

  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});