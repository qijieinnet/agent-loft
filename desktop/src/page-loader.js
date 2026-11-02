// 首次加载和手动重试时，给尚未启动的服务端一分钟准备时间。
// 只重试临时网络错误；证书、地址格式等错误立即交给界面处理。
const RETRYABLE = new Set([
  "ERR_CONNECTION_REFUSED", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_ABORTED", "ERR_CONNECTION_TIMED_OUT", "ERR_TIMED_OUT",
  "ERR_NAME_NOT_RESOLVED", "ERR_NETWORK_CHANGED", "ERR_INTERNET_DISCONNECTED",
  "ERR_ADDRESS_UNREACHABLE", "ERR_TUNNEL_CONNECTION_FAILED",
]);
const RETRY_WINDOW = 60_000;
const RETRY_INTERVAL = 2000;
const MAX_RETRIES = 30;

/** 管理一张服务器页面的加载；切换标签不取消，销毁视图时取消所有重试。 */
export function createPageLoader(wc, { url, canRetry = () => true, onConnecting, onFailure, onLoaded }) {
  let active = false;
  let failed = false;
  let startedAt = 0;
  let retries = 0;
  let timer;
  let disposed = false;

  function load() {
    if (disposed || wc.isDestroyed()) return;
    failed = false;
    // did-fail-load 负责错误处理；loadURL 的 Promise 也会拒绝，避免未处理的拒绝。
    void wc.loadURL(url).catch(() => {});
  }

  function start() {
    if (disposed || wc.isDestroyed()) return;
    clearTimeout(timer);
    active = true;
    startedAt = Date.now();
    retries = 0;
    onConnecting();
    load();
  }

  function fail(_e, code, message, failedUrl, isMainFrame) {
    // -3 是被新的导航打断，不算失败；子框架也不影响整张页面。
    if (disposed || !isMainFrame || code === -3) return;
    failed = true;
    clearTimeout(timer);
    const remaining = RETRY_WINDOW - (Date.now() - startedAt);
    if (active && RETRYABLE.has(message.replace(/^net::/, "")) && canRetry(failedUrl) && retries < MAX_RETRIES && remaining > 0) {
      retries++;
      timer = setTimeout(load, Math.min(RETRY_INTERVAL, remaining));
      return;
    }
    active = false;
    onFailure({ code, message });
  }

  function finish() {
    // Chromium 的错误页也可能触发 did-finish-load，不能当作连接成功。
    if (disposed || failed) return;
    active = false;
    clearTimeout(timer);
    onLoaded();
  }

  function dispose() {
    disposed = true;
    clearTimeout(timer);
    wc.removeListener("did-fail-load", fail);
    wc.removeListener("did-finish-load", finish);
    wc.removeListener("destroyed", dispose);
  }

  wc.on("did-fail-load", fail);
  wc.on("did-finish-load", finish);
  wc.once("destroyed", dispose);
  return { start };
}
