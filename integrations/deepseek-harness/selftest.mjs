/**
 * 适配层自检：不依赖 dsh 运行时，也不访问腾讯云。
 * 覆盖入口解析、env 显式转发、默认值与参数校验。
 *
 * 运行：node integrations/deepseek-harness/selftest.mjs
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CREDENTIAL_REFS,
  apply,
  buildClientConfig,
  collectEnv,
  readCredentialEnv,
  resolveEntry,
} from "./index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HERE = dirname(fileURLToPath(import.meta.url));

const results = [];
function report(name, fn, error) {
  const ok = error === undefined;
  results.push({ name, ok });
  if (ok) console.log(`PASS  ${name}`);
  else console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
}
function check(name, fn) {
  try {
    fn();
    report(name, fn);
  } catch (err) {
    report(name, fn, err);
  }
}
async function acheck(name, fn) {
  try {
    await fn();
    report(name, fn);
  } catch (err) {
    report(name, fn, err);
  }
}

const planted = {
  TC_SECRET_ID: "AKIDselftest",
  TC_SECRET_KEY: "sk-selftest",
  TC_CRED_FILE: "C:/tmp/cred.csv",
  RB_TOOL_NAME: "remote-browser-selftest",
  UNRELATED_SECRET: "must-not-leak",
  DSH_HOME: "must-not-leak",
  AWS_SECRET_ACCESS_KEY: "must-not-leak",
};

for (const [key, value] of Object.entries(planted)) process.env[key] = value;

check("默认入口指向仓库 dist/index.js", () => {
  const entry = resolveEntry();
  assert.equal(entry, resolve(REPO_ROOT, "dist/index.js"));
});

check("默认配置形如 dsh-mcp-client 的 stdio 段", () => {
  const cfg = buildClientConfig();
  assert.equal(cfg.transport, "stdio");
  assert.equal(cfg.serverName, "remote_browser");
  assert.equal(cfg.command, process.execPath);
  assert.deepEqual(cfg.args, [resolve(REPO_ROOT, "dist/index.js")]);
  assert.equal(cfg.cwd, REPO_ROOT);
  assert.equal(cfg.toolCallTimeoutMs, 240_000);
  assert.equal(cfg.failOnStartupError, false);
});

check("TC_* / RB_* 被显式转发，其它凭证不外泄", () => {
  const env = collectEnv();
  assert.equal(env.TC_SECRET_ID, "AKIDselftest");
  assert.equal(env.TC_SECRET_KEY, "sk-selftest");
  assert.equal(env.TC_CRED_FILE, "C:/tmp/cred.csv");
  assert.equal(env.RB_TOOL_NAME, "remote-browser-selftest");
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.equal(env.DSH_HOME, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
});

check("长驻场景的回收默认值生效", () => {
  const env = collectEnv();
  assert.equal(env.RB_TOOL_DELETE_ON_EXIT, "1");
  assert.equal(env.RB_TOOL_IDLE_MS, "600000");
  assert.equal(env.RB_TRANSPORT, "STDIO");
});

check("users 配置优先级高于默认值，但传输方式被强制为 stdio", () => {
  const env = collectEnv({ env: { RB_TOOL_IDLE_MS: "0", RB_TRANSPORT: "HTTP", EXTRA: "1" } });
  assert.equal(env.RB_TOOL_IDLE_MS, "0");
  assert.equal(env.EXTRA, "1");
  assert.equal(env.RB_TRANSPORT, "STDIO");
});

check("凭证库是低优先级层：默认值 < 凭证库 < 进程环境 < config.env", () => {
  const env = collectEnv(
    { env: { RB_IDLE_ACTION: "STOP" } },
    { RB_IDLE_ACTION: "PAUSE", RB_REGION_UNUSED: "", RB_MAX_SESSIONS: "5", TC_SECRET_ID: "from-store" }
  );
  // config.env 最高
  assert.equal(env.RB_IDLE_ACTION, "STOP");
  // 凭证库覆盖默认值
  assert.equal(env.RB_MAX_SESSIONS, "5");
  // 进程环境变量压过凭证库（planted.TC_SECRET_ID）
  assert.equal(env.TC_SECRET_ID, "AKIDselftest");
  // 空值不落进子进程
  assert.equal(env.RB_REGION_UNUSED, undefined);
  // 默认值仍在
  assert.equal(env.RB_TOOL_IDLE_MS, "600000");
});

check("buildClientConfig 接受凭证库结果", () => {
  const cfg = buildClientConfig({}, { RB_LOG_LEVEL: "DEBUG" });
  assert.equal(cfg.env.RB_LOG_LEVEL, "DEBUG");
  assert.equal(cfg.env.RB_TRANSPORT, "STDIO");
});

check("CREDENTIAL_REFS 覆盖设置页的两组字段", () => {
  assert.deepEqual(
    [...CREDENTIAL_REFS],
    [
      "TC_SECRET_ID",
      "TC_SECRET_KEY",
      "TC_REGION",
      "RB_IDLE_MS",
      "RB_IDLE_ACTION",
      "RB_MAX_SESSIONS",
      "RB_TOOL_IDLE_MS",
      "RB_LOG_LEVEL",
    ]
  );
});

check("非法 serverName 直接报错", () => {
  assert.throws(() => buildClientConfig({ serverName: "bad name!" }), /serverName/);
});

check("入口不存在时提示先构建", () => {
  assert.throws(() => buildClientConfig({ entry: "C:/definitely/missing/index.js" }), /npm run build/);
});

check("相对入口被拒绝", () => {
  assert.throws(() => buildClientConfig({ entry: "./dist/index.js" }), /绝对路径/);
});

check("非正数 toolCallTimeoutMs 被拒绝", () => {
  assert.throws(() => buildClientConfig({ toolCallTimeoutMs: 0 }), /toolCallTimeoutMs/);
});

// 以下检查需要 integrations/deepseek-harness 下执行过 npm install，缺失时跳过。
try {
  const mcp = await import("@deepseek-ai/dsh-mcp-client");

  check("配置通过 dsh-mcp-client 的 schema 校验", () => {
    const parsed = mcp.Config(buildClientConfig());
    assert.equal(parsed.transport, "stdio");
    assert.equal(parsed.serverName, "remote_browser");
    assert.equal(parsed.toolCallTimeoutMs, 240_000);
    assert.equal(parsed.cwd, REPO_ROOT);
  });

  check("dsh-mcp-client 同样拒绝非法 serverName", () => {
    assert.throws(() => mcp.Config({ ...buildClientConfig(), serverName: "bad name!" }));
  });

  let mounted = null;
  await apply(
    { plugin: async (plugin, config) => { mounted = { plugin, config }; } },
    { serverName: "selftest_ns" }
  );

  check("apply 用正确配置挂载 dsh-mcp-client 子插件", () => {
    assert.ok(mounted, "ctx.plugin 没有被调用");
    assert.equal(mounted.plugin.name, "mcp-client");
    assert.deepEqual(mounted.plugin.inject, ["tools"]);
    assert.equal(mounted.config.serverName, "selftest_ns");
    assert.equal(mounted.config.args[0], resolve(REPO_ROOT, "dist/index.js"));
  });
} catch (err) {
  console.log(`SKIP  dsh-mcp-client 未安装，跳过 schema / 挂载检查（${err.code ?? "n/a"}）`);
}

try {
  const { default: YAML } = await import("yaml");
  const patch = YAML.parse(await (await import("node:fs/promises")).readFile(new URL("./cordis.patch.yml", import.meta.url), "utf8"));

  check("cordis.patch.yml 结构可被解析", () => {
    assert.ok(Array.isArray(patch) && patch.length === 1);
    const row = patch[0].insert?.[0];
    assert.equal(row.id, "remote-browser");
    assert.equal(row.name, "dsh-plugin-remote-browser");
    assert.equal(row.config.serverName, "remote_browser");
  });
} catch (err) {
  console.log(`SKIP  yaml 未安装，跳过 patch 文件解析（${err.code ?? "n/a"}）`);
}

await acheck("readCredentialEnv 只读已知引用，跳过空值与异常", async () => {
  const values = { TC_SECRET_ID: "AKIDfromstore", RB_IDLE_MS: "  ", RB_LOG_LEVEL: "DEBUG" };
  const ctx = {
    get: (name) =>
      name === "credentials"
        ? {
            resolve: async (ref) => {
              if (ref === "TC_SECRET_KEY") throw new Error("provider hiccup");
              const value = values[ref];
              return value === undefined ? undefined : { value, source: "file" };
            },
          }
        : undefined,
  };
  const env = await readCredentialEnv(ctx);
  assert.equal(env.TC_SECRET_ID, "AKIDfromstore");
  assert.equal(env.RB_LOG_LEVEL, "DEBUG");
  assert.equal(env.RB_IDLE_MS, undefined, "空白值不应注入");
  assert.equal(env.TC_SECRET_KEY, undefined, "解析失败的引用应跳过");
});

await acheck("没有 credentials 服务时安静跳过", async () => {
  assert.deepEqual(await readCredentialEnv({ get: () => undefined }), {});
  assert.deepEqual(await readCredentialEnv({}), {});
});

await acheck("apply 在设置变化后用 fiber.update 重启子进程", async () => {
  const store = { TC_SECRET_ID: "before", RB_LOG_LEVEL: "INFO" };
  const credentials = {
    resolve: async (ref) => (store[ref] === undefined ? undefined : { value: store[ref], source: "file" }),
  };
  const updates = [];
  const fakeFiber = {
    update: async (config) => {
      updates.push(config);
    },
  };
  let listener;
  let subscribedEvent;
  let disposed = false;
  const ctx = {
    plugin: async () => fakeFiber,
    get: (name) => (name === "credentials" ? credentials : undefined),
    on: (event, fn) => {
      // 只认 dsh 0.2.x 声明的事件名；写错名字时 listener 为空，下面的断言会失败。
      subscribedEvent = event;
      if (event === "credentials/reference-updated") listener = fn;
      return () => {
        listener = undefined;
      };
    },
    effect: (fn) => {
      const dispose = fn();
      disposed = typeof dispose === "function";
      return () => {
        dispose?.();
      };
    },
    logger: { info() {}, error() {} },
  };

  const original = process.env.TC_SECRET_ID;
  delete process.env.TC_SECRET_ID; // 让凭证库这一层可见
  try {
    await apply(ctx, { serverName: "selftest_watch" });
    assert.equal(subscribedEvent, "credentials/reference-updated", "应订阅 dsh 0.2.x 的凭证变更事件");
    assert.ok(listener, "应注册 credentials/reference-updated 监听");
    assert.equal(disposed, true, "监听应挂在 effect 上");

    listener("UNRELATED_REF");
    await new Promise((done) => setTimeout(done, 400));
    assert.equal(updates.length, 0, "无关引用不应触发重启");

    store.TC_SECRET_ID = "after";
    listener("TC_SECRET_ID");
    await new Promise((done) => setTimeout(done, 400));
    assert.equal(updates.length, 1, "引用变化应重启一次");
    assert.equal(updates[0].env.TC_SECRET_ID, "after");

    listener("TC_SECRET_ID");
    await new Promise((done) => setTimeout(done, 400));
    assert.equal(updates.length, 1, "值没变不应重复重启");
  } finally {
    if (original === undefined) delete process.env.TC_SECRET_ID;
    else process.env.TC_SECRET_ID = original;
  }
});

await acheck("浏览器半边是合法的 ModuleLoader 产物", async () => {
  const source = await readFile(resolve(HERE, "client.js"), "utf8");
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, /id:\s*"dsh-plugin-remote-browser"/);
  assert.match(source, /exports\.apply = apply;/);
  assert.match(source, /exports\.inject = inject;/);
  for (const ref of CREDENTIAL_REFS) {
    assert.ok(source.includes(`"${ref}"`), `client.js 缺少字段 ${ref}`);
  }
});

await acheck("浏览器半边能加载并把分区注册到 settings.section", async () => {
  const source = await readFile(resolve(HERE, "client.js"), "utf8");
  let loaded;
  const fakeWindow = {
    __ModuleLoader__: {
      load: (record) => {
        loaded = record;
      },
    },
  };
  const stubReact = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  const stubRequire = (id) => {
    if (id === "react") return stubReact;
    throw new Error(`client.js 不应 require "${id}"`);
  };
  // document 不传入：bundle 顶层的 CSS 注入必须容忍非浏览器环境。
  new Function("window", "document", "require", source)(fakeWindow, undefined, stubRequire);

  assert.ok(loaded, "没有调用 window.__ModuleLoader__.load");
  assert.equal(loaded.id, "dsh-plugin-remote-browser");
  const clientModule = loaded.factory(stubRequire);
  assert.deepEqual(clientModule.inject, ["slots", "connection"]);

  const registered = [];
  const ctx = {
    get: (name) => (name === "connection" ? { api: {}, isLoopback: true } : undefined),
    slots: {
      inject: (key, callback) => {
        registered.push({ inject: key });
        callback();
      },
      register: (options) => {
        registered.push({ options });
        return () => {};
      },
    },
  };
  clientModule.apply(ctx);

  const section = registered.find((item) => item.options);
  assert.equal(registered[0].inject, "settings.section");
  assert.equal(section.options.name, "settings.section");
  assert.equal(section.options.id, "remote-browser");
  assert.equal(section.options.label, "远端浏览器");
});

await acheck("package.json 把 host / client 两半都挂好了", async () => {
  const pkg = JSON.parse(await readFile(resolve(HERE, "package.json"), "utf8"));
  assert.equal(pkg.exports["./client"].default, "./client.js");
  assert.ok(pkg.files.includes("client.js"));
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(pkg.dsh.client.platform, "web");
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0);
});

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length === 0 ? 0 : 1;