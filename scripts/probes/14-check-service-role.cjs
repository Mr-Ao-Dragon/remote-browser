/**
 * 探针 14：检查 AGS 服务相关角色是否存在，并读取其 ARN
 * 服务相关角色：AGS_QCSLinkedRoleInSandboxTool（载体 sandboxtool.ags.cloud.tencent.com）
 * 该角色自带 tcr:PullRepository / tcr:CreateInstanceToken 等权限，可能直接可用于镜像拉取。
 */
const { makeClient } = require("../lib/tc-generic");

const errInfo = (e) => ({
  code: (e && e.code) || "UNKNOWN",
  message: String((e && e.message) || e).slice(0, 240),
});

const NAMES = [
  "AGS_QCSLinkedRoleInSandboxTool",
  "AGC_QCSLinkedRoleInResourceAccess",
];

(async () => {
  const cam = makeClient("cam", "2019-01-16", "ap-shanghai");
  const out = [];
  for (const RoleName of NAMES) {
    try {
      const r = await cam.request("GetRole", { RoleName });
      out.push({
        roleName: RoleName,
        ok: true,
        qcsRoleArn: r.Role ? `qcs::cam::uin/${r.Role.Uin}:roleName/${r.Role.RoleName}` : undefined,
        roleId: r.Role && r.Role.RoleId,
        uin: r.Role && r.Role.Uin,
        addTime: r.Role && r.Role.AddTime,
        description: r.Role && r.Role.Description,
        policyDocument: r.Role && r.Role.PolicyDocument,
      });
    } catch (e) {
      out.push({ roleName: RoleName, ok: false, error: errInfo(e) });
    }
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: errInfo(e) }, null, 2));
  process.exit(1);
});