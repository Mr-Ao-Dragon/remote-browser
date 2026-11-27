import fs from "node:fs";
// 用静态 import 而非 createRequire：bundle 成单文件时 SDK 才能被内联，
// 否则运行时按 bundle 所在目录解析 node_modules 会失败。
import { ags } from "tencentcloud-sdk-nodejs-ags";
import { AbstractClient } from "tencentcloud-sdk-nodejs-common";
import { config } from "../config.js";
import { RbError } from "../errors.js";
import { log } from "../logger.js";
import { redact, registerSecret } from "../redact.js";

export interface Credential {
  secretId: string;
  secretKey: string;
  token?: string;
}

export type AgsClient = InstanceType<(typeof ags)["v20250920"]["Client"]>;

let cachedRole: { credential: Credential; expiresAt: number } | null = null;

function readCredentialFile(file: string): Credential {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new RbError("credential_missing", "凭证文件格式无法识别");
  const header = lines[0].split(",").map((cell) => cell.trim());
  const row = lines[1].split(",").map((cell) => cell.trim());
  const secretId = row[header.findIndex((name) => /secretid/i.test(name))];
  const secretKey = row[header.findIndex((name) => /secretkey/i.test(name))];
  if (!secretId || !secretKey) throw new RbError("credential_missing", "凭证文件缺少 SecretId 或 SecretKey");
  return { secretId, secretKey };
}

/** 调 STS AssumeRole 换取临时凭证，缓存到到期前 5 分钟。 */
async function assumeRole(base: Credential): Promise<Credential> {
  if (cachedRole && cachedRole.expiresAt - Date.now() > 5 * 60_000) return cachedRole.credential;

  const sts = new AbstractClient("sts.tencentcloudapi.com", "2018-08-13", {
    credential: base,
    region: config.region,
    profile: { httpProfile: { reqTimeout: 30 }, signMethod: "TC3-HMAC-SHA256" },
  });
  const res = (await sts.request("AssumeRole", {
    RoleArn: config.roleArn,
    RoleSessionName: config.roleSessionName,
    DurationSeconds: 3600,
  })) as {
    Credentials?: { TmpSecretId: string; TmpSecretKey: string; Token: string };
    ExpiredTime?: number;
    Response?: { Credentials?: { TmpSecretId: string; TmpSecretKey: string; Token: string }; ExpiredTime?: number };
  };
  const body = res?.Credentials ? res : res?.Response;
  if (!body?.Credentials) throw new RbError("credential_invalid", "AssumeRole 未返回临时凭证");

  const credential: Credential = {
    secretId: body.Credentials.TmpSecretId,
    secretKey: body.Credentials.TmpSecretKey,
    token: body.Credentials.Token,
  };
  registerSecret(credential.secretId);
  registerSecret(credential.secretKey);
  registerSecret(credential.token);
  cachedRole = {
    credential,
    expiresAt: body.ExpiredTime ? body.ExpiredTime * 1000 : Date.now() + 55 * 60_000,
  };
  log.info("control-plane credential assumed from role");
  return credential;
}

/** 解析控制面凭证：环境变量优先，其次 CSV 文件；配置了角色则先 AssumeRole。 */
export async function resolveCredential(): Promise<Credential> {
  let base: Credential;
  if (config.secretId && config.secretKey) {
    base = { secretId: config.secretId, secretKey: config.secretKey };
  } else {
    try {
      base = readCredentialFile(config.credFile);
    } catch (err) {
      throw new RbError(
        "credential_missing",
        `未找到控制面凭证：请设置 TC_SECRET_ID / TC_SECRET_KEY，或提供 TC_CRED_FILE（${redact(
          err instanceof Error ? err.message : ""
        )}）`,
        err
      );
    }
  }
  registerSecret(base.secretId);
  registerSecret(base.secretKey);
  return config.roleArn ? assumeRole(base) : base;
}

export async function createAgsClient(): Promise<AgsClient> {
  const credential = await resolveCredential();
  return new ags.v20250920.Client({
    credential,
    region: config.region,
    profile: {
      httpProfile: { endpoint: "ags.tencentcloudapi.com", reqTimeout: 60 },
      signMethod: "TC3-HMAC-SHA256",
    },
  }) as AgsClient;
}