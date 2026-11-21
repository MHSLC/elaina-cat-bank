export async function localReviewAvailability(device = globalThis.navigator, secure = globalThis.isSecureContext) {
  if (!secure) return "本机 Qwen 需要从 HTTPS 地址打开。";
  if (typeof device?.gpu?.requestAdapter !== "function") return "当前浏览器没有 WebGPU。请用最新版 Edge 或 Chrome 直接打开网页。";
  let timeout;
  try {
    const adapter = await Promise.race([
      device.gpu.requestAdapter(),
      new Promise(resolve => { timeout = setTimeout(resolve, 3500); })
    ]);
    if (adapter) return "";
    return "浏览器没有找到可用的 WebGPU 显卡。请检查浏览器的图形加速，或改用 ChatGPT 评审。";
  } catch {
    return "WebGPU 检测失败，请重试或改用 ChatGPT 评审。";
  } finally {
    clearTimeout(timeout);
  }
}

export function createLocalReviewer(newWorker = () => new Worker(new URL("./local-ai-worker.js?v=3", import.meta.url), { type: "module" })) {
  let worker;
  return (input, { signal, onProgress = () => {} } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    worker ??= newWorker();
    const active = worker;
    const stop = () => complete(signal.reason);
    const fail = () => complete(new Error("本机评审未能启动，可以改用 ChatGPT 评审。"));
    let timer;
    let lastUpdate;
    function waitForUpdate(report = {}) {
      const update = JSON.stringify(report);
      if (update === lastUpdate) return;
      lastUpdate = update;
      clearTimeout(timer);
      const message = report.phase === "review"
        ? "本机模型评审超时，可以重试或切换到 ChatGPT 评审。"
        : "本机模型长时间没有加载进展。可检查网络后重试，或切换到 ChatGPT 评审。";
      timer = setTimeout(() => complete(new Error(message)), 5 * 60 * 1000);
    }
    const receive = ({ data }) => {
      if (data?.type === "progress") {
        waitForUpdate(data.report);
        onProgress(data.report);
      }
      if (data?.type === "error") complete(new Error(data.message));
      if (data?.type === "verdict") complete(null, data.verdict);
    };

    function complete(error, verdict) {
      clearTimeout(timer);
      active.removeEventListener("message", receive);
      active.removeEventListener("error", fail);
      signal?.removeEventListener("abort", stop);
      if (error) {
        active.terminate();
        worker = undefined;
        reject(error);
      } else {
        resolve(verdict);
      }
    }

    active.addEventListener("message", receive);
    active.addEventListener("error", fail);
    signal?.addEventListener("abort", stop, { once: true });
    waitForUpdate();
    try {
      active.postMessage(input);
    } catch (error) {
      complete(error);
    }
  });
}

export function readLocalVerdict(raw) {
  const value = typeof raw === "string" ? raw.trim().replace(/^(?:<think>[\s\S]*?<\/think>\s*)/, "") : "";
  const result = JSON.parse(value)?.verdict;
  if (!["pass", "fail", "uncertain"].includes(result)) throw new Error("无效的本机评审判定");
  return result;
}
