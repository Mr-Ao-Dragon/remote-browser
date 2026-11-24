/**
 * 沙箱内 Chromium 启动参数与启动脚本。
 *
 * AGS 的 /init 只负责 nginx 与平台组件，浏览器必须自己拉起；
 * 这里带一个崩溃重启循环，并让主进程保持存活。
 */
export const CHROME_FLAGS: readonly string[] = [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--window-size=1440,900",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=9222",
  "--user-data-dir=/tmp/cdpprofile",
];

/**
 * 传给沙箱工具的 Args：`/bin/sh -c BROWSER_BOOTSTRAP`。
 * 每段自带分号，避免后台任务 `&` 后接出非法的 `&;`。
 */
export const BROWSER_BOOTSTRAP = [
  "set -u;",
  'CHROME=$(command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable);',
  '[ -z "$CHROME" ] && { echo "remote-browser: chromium not found" >&2; exit 1; };',
  "mkdir -p /tmp/cdpprofile;",
  `( while true; do "$CHROME" ${CHROME_FLAGS.join(" ")} about:blank >> /tmp/chrome.log 2>&1; sleep 1; done ) &`,
  "exec sleep infinity",
].join(" ");