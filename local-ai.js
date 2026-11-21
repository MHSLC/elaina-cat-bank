export async function supportsLocalReview(device = globalThis.navigator, secure = globalThis.isSecureContext) {
  if (!secure || typeof device?.gpu?.requestAdapter !== "function") return false;
  try {
    return Boolean(await device.gpu.requestAdapter());
  } catch {
    return false;
  }
}

export function createLocalReviewer(newWorker = () => new Worker(new URL("./local-ai-worker.js", import.meta.url), { type: "module" })) {
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
    const receive = ({ data }) => {
      if (data?.type === "progress") onProgress(data.value);
      if (data?.type === "error") complete(new Error(data.message));
      if (data?.type === "verdict") complete(null, data.verdict);
    };
    const timer = setTimeout(() => complete(new Error("本机评审超时，可以重新尝试。")), 10 * 60 * 1000);

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
