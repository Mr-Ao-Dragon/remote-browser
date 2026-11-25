/**
 * dsh 浏览器半边：设置弹窗里的「远端浏览器」标签页。
 *
 * dsh 对第三方插件只开放 `credentials.describe/set/unset` 这一个通用可写通道
 * （settings 命名空间有白名单，第三方插件写入会被 settings-not-exposed 拒绝）。
 * 因此这里所有字段都走凭证库：引用名就是环境变量名，与进程环境变量同名同义。
 *
 * 密钥只写不读：describe 只告诉界面"配没配、来自哪层、可不可写"，从不返回明文。
 * 所以输入框永远是空的——留空即保持现值。非密钥项同理，默认值写在 placeholder 里。
 */

window.__ModuleLoader__.load({
	id: "dsh-plugin-remote-browser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;

		// 与 index.js 的 CREDENTIAL_REFS 保持一致（selftest 会校验不漂移）。
		const SECRET_FIELDS = [
			{
				ref: "TC_SECRET_ID",
				label: "SecretId",
				secret: true,
				placeholder: "AKID…",
				hint: "腾讯云 API 密钥 ID。只写入 dsh 凭证库，不会出现在工具返回值或日志里。",
			},
			{
				ref: "TC_SECRET_KEY",
				label: "SecretKey",
				secret: true,
				placeholder: "填写后点保存",
				hint: "与 SecretId 配对使用；也可以改用控制台导出的凭证文件（TC_CRED_FILE）。",
			},
		];

		const OPTION_FIELDS = [
			{ ref: "TC_REGION", label: "地域", placeholder: "ap-shanghai", hint: "控制面地域。" },
			{ ref: "RB_IDLE_MS", label: "会话空闲回收", placeholder: "90000", hint: "毫秒。空闲超过该时长即回收会话。" },
			{ ref: "RB_IDLE_ACTION", label: "空闲动作", placeholder: "PAUSE", hint: "PAUSE 暂停实例，STOP 直接停止（停止后不可回滚）。" },
			{ ref: "RB_MAX_SESSIONS", label: "并发会话上限", placeholder: "10", hint: "超出后拒绝新建，保护配额。" },
			{ ref: "RB_TOOL_IDLE_MS", label: "工具空闲回收", placeholder: "600000", hint: "毫秒。本插件默认 10 分钟。" },
			{ ref: "RB_LOG_LEVEL", label: "日志级别", placeholder: "INFO", hint: "DEBUG / INFO / WARN / ERROR。" },
		];

		const ALL_REFS = SECRET_FIELDS.concat(OPTION_FIELDS).map((field) => field.ref);

		const CSS_ID = "dsh-plugin-remote-browser/SettingsSection.css";
		const CSS = [
			".rbs_section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}",
			".rbs_heading{margin:0;font-size:18px;font-weight:600}",
			".rbs_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:1.6}",
			".rbs_warn{border:1px solid var(--dsw-alias-label-error);color:var(--dsw-alias-label-error);border-radius:8px;margin:0;padding:8px 12px;font-size:12px;line-height:1.6}",
			".rbs_group{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:2px 16px}",
			".rbs_groupTitle{margin:14px 0 0;font-size:14px;font-weight:600;line-height:1.5}",
			".rbs_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}",
			".rbs_field+.rbs_field{border-top:1px solid var(--dsw-alias-border-l2)}",
			".rbs_head{align-items:center;gap:8px;display:flex}",
			".rbs_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}",
			".rbs_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}",
			".rbs_badgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}",
			".rbs_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}",
			".rbs_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
			".rbs_reset:disabled{opacity:.4;cursor:default}",
			".rbs_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}",
			".rbs_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
			".rbs_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
			".rbs_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
			".rbs_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0;display:flex}",
			".rbs_notice{min-width:0;flex:1;margin:0;font-size:12px;line-height:1.5}",
			".rbs_ok{color:var(--dsw-alias-label-secondary)}",
			".rbs_error{color:var(--dsw-alias-label-error)}",
			".rbs_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
			".rbs_save:disabled{opacity:.4;cursor:default}",
		].join("");

		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-remote-browser";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const inject = ["slots", "connection"];

		function messageOf(error) {
			if (error instanceof Error) return error.message;
			return String(error);
		}

		/** rpc 结果里的失败信息：code + message，都不含凭证明文。 */
		function describeError(response) {
			const failure = response && response.result && response.result.error;
			if (!failure) return "未知错误";
			return failure.code ? failure.code + "：" + failure.message : String(failure.message);
		}

		function isFailure(response) {
			return !response || !response.result || response.result.ok !== true;
		}

		function statusBadge(info, loading) {
			if (loading) return h("span", { className: "rbs_badgeMuted" }, "读取中…");
			if (!info) return h("span", { className: "rbs_badgeMuted" }, "状态未知");
			if (!info.configured) return h("span", { className: "rbs_badgeMuted" }, "未设置，用默认值");
			if (info.writable === false) {
				return h("span", { className: "rbs_badge", title: info.source ? "来源：" + info.source : undefined }, "只读");
			}
			return h("span", { className: "rbs_badge", title: info.source ? "来源：" + info.source : undefined }, "已设置");
		}

		function apply(ctx) {
			const connection = ctx.get("connection");
			const api = connection.api;
			const loopback = connection.isLoopback !== false;

			function RemoteBrowserSection() {
				const [status, setStatus] = react.useState(null);
				const [drafts, setDrafts] = react.useState({});
				const [busy, setBusy] = react.useState(false);
				const [notice, setNotice] = react.useState(null);

				const refresh = react.useCallback(
					function () {
						return api.credentials
							.describe({ refs: ALL_REFS })
							.then(function (response) {
								if (isFailure(response)) throw new Error(describeError(response));
								setStatus(response.result.value.credentials || {});
							})
							.catch(function (error) {
								setStatus(function (previous) {
									return previous || {};
								});
								setNotice({ kind: "error", text: "读取配置状态失败：" + messageOf(error) });
							});
					},
					[]
				);

				react.useEffect(function () {
					refresh();
				}, [refresh]);

				function setDraft(ref, value) {
					setDrafts(function (previous) {
						const next = Object.assign({}, previous);
						if (value === "") delete next[ref];
						else next[ref] = value;
						return next;
					});
				}

				function save() {
					const refs = Object.keys(drafts);
					if (refs.length === 0) return;
					setBusy(true);
					setNotice(null);
					const failures = [];
					const succeeded = [];
					let chain = Promise.resolve();
					refs.forEach(function (ref) {
						chain = chain.then(function () {
							return api.credentials.set({ ref: ref, value: drafts[ref] }).then(
								function (response) {
									if (isFailure(response)) failures.push(ref + "（" + describeError(response) + "）");
									else succeeded.push(ref);
								},
								function (error) {
									failures.push(ref + "（" + messageOf(error) + "）");
								}
							);
						});
					});
					chain
						.then(function () {
							// 只清掉写成功的草稿，失败的保留给用户改。
							setDrafts(function (previous) {
								const next = Object.assign({}, previous);
								for (const ref of succeeded) delete next[ref];
								return next;
							});
							setNotice(
								failures.length > 0
									? { kind: "error", text: "部分保存失败（已成功的已生效）：" + failures.join("；") }
									: { kind: "ok", text: "已保存，插件会自动重启 MCP 子进程使新配置生效。" }
							);
							return refresh();
						})
						.then(
							function () {
								setBusy(false);
							},
							function () {
								setBusy(false);
							}
						);
				}

				function clearRef(ref) {
					setBusy(true);
					setNotice(null);
					api.credentials.unset({ ref: ref }).then(
						function (response) {
							setNotice(
								isFailure(response)
									? { kind: "error", text: "清除 " + ref + " 失败：" + describeError(response) }
									: { kind: "ok", text: "已清除 " + ref + "，恢复默认值。" }
							);
							return refresh();
						},
						function (error) {
							setNotice({ kind: "error", text: "清除 " + ref + " 失败：" + messageOf(error) });
						}
					).then(
						function () {
							setBusy(false);
						},
						function () {
							setBusy(false);
						}
					);
				}

				function renderField(field) {
					const isLoading = status === null;
					const info = status ? status[field.ref] : null;
					const writable = !info || info.writable !== false;
					const value = drafts[field.ref] !== undefined ? drafts[field.ref] : "";
					const canClear = Boolean(info && info.configured && info.writable);
					return h(
						"div",
						{ className: "rbs_field", key: field.ref },
						h(
							"div",
							{ className: "rbs_head" },
							h("label", { className: "rbs_label", htmlFor: "rbs-" + field.ref }, field.label),
							statusBadge(info, isLoading),
							h(
								"button",
								{
									type: "button",
									className: "rbs_reset",
									disabled: busy || !canClear,
									onClick: function () {
										clearRef(field.ref);
									},
								},
								"清除"
							)
						),
						h("input", {
							id: "rbs-" + field.ref,
							className: "rbs_input",
							type: field.secret ? "password" : "text",
							value: value,
							disabled: busy || !writable,
							placeholder: writable ? field.placeholder : "由环境变量提供，此处不可写",
							autoComplete: "off",
							spellCheck: false,
							onChange: function (event) {
								setDraft(field.ref, event.target.value);
							},
						}),
						h("p", { className: "rbs_hint" }, field.hint, " 变量名 ", field.ref, "。")
					);
				}

				const dirty = Object.keys(drafts).length > 0;

				return h(
					"div",
					{ className: "rbs_section" },
					h("h2", { className: "rbs_heading" }, "远端浏览器"),
					h(
						"p",
						{ className: "rbs_intro" },
						"控制腾讯云 AGS 浏览器沙箱的凭证与运行参数。值保存在 dsh 凭证库里，环境变量里的同名变量优先且此时此处只读。"
					),
					loopback
						? null
						: h("p", { className: "rbs_warn" }, "当前不是本机页面访问，dsh 只允许本机同源页面写入凭证，保存会被拒绝。"),
					h("div", { className: "rbs_group" }, h("h3", { className: "rbs_groupTitle" }, "云平台凭证"), SECRET_FIELDS.map(renderField)),
					h(
						"div",
						{ className: "rbs_group" },
						h("h3", { className: "rbs_groupTitle" }, "运行参数"),
						OPTION_FIELDS.map(renderField)
					),
					h(
						"div",
						{ className: "rbs_footer" },
						notice
							? h("p", { className: "rbs_notice " + (notice.kind === "error" ? "rbs_error" : "rbs_ok") }, notice.text)
							: h("p", { className: "rbs_notice rbs_ok" }, dirty ? "有未保存的修改。" : "留空表示保持现值。"),
						h(
							"button",
							{ type: "button", className: "rbs_save", disabled: busy || !dirty, onClick: save },
							busy ? "保存中…" : "保存"
						)
					)
				);
			}

			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "remote-browser",
						order: 90,
						label: "远端浏览器",
					},
					RemoteBrowserSection
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});