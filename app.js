import { chooseProblem, difficultyScales, earnedPoints, getScore, handoffPrompt, luoguDifficulty, matchingProblems, parseImportedReview } from "./logic.js";
import { createLocalReviewer, localReviewAvailability } from "./local-ai.js?v=2";
import renderMathInElement from "./auto-render.js";

const $ = id => document.getElementById(id);
const storageKey = "kouhu.arena.v1";
const emptyState = () => ({ currentId: null, seen: [], drafts: {}, contexts: {}, history: [], filters: null, ranges: {} });
const format = new Intl.NumberFormat("zh-CN");
const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const answer = $("answer");
const contextInput = $("context-input");
const dialog = $("review-dialog");
const reviewMode = $("review-mode");
const reviewLocal = createLocalReviewer();
let state = emptyState();
let problems = [];
let autoJudge = false;
let localIssue;
let localController;
let activeReview;
let busy = false;
let ready = false;
let current;

try {
  const stored = JSON.parse(localStorage.getItem(storageKey) ?? "null");
  if (stored && Array.isArray(stored.history) && Array.isArray(stored.seen) && stored.drafts) {
    state = { ...emptyState(), ...stored };
  }
} catch {
  // 浏览器阻止存储时，当前页面仍可使用。
}

function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch {}
}

function filters() {
  const platform = $("platform").value;
  const detailedOnly = $("detailed-only").checked;
  return { platform, detailedOnly, min: Number($("min-rating").value), max: Number($("max-rating").value) };
}

function loadDifficultyRange() {
  const platform = $("platform").value;
  const scale = difficultyScales[platform];
  $("difficulty-field").hidden = !scale;
  if (!scale) return;
  $("difficulty-label").textContent = scale.label;
  const savedRange = state.ranges[platform] ?? scale.defaults;
  for (const [index, id] of ["min-rating", "max-rating"].entries()) {
    const field = $(id);
    field.replaceChildren(...scale.levels.map(([value, label]) => new Option(label, value)));
    const preferred = savedRange[index];
    field.value = scale.levels.some(([value]) => value === preferred) ? preferred : scale.defaults[index];
  }
}

function showPool() {
  const settings = filters();
  const pool = matchingProblems(problems, settings, state.history);
  $("draw-button").disabled = busy || !ready || !pool.length;
  if (ready) {
    const { platform, min, max } = settings;
    $("pool-count").textContent = platform !== "all" && min > max ? "最低难度不能高于最高难度" :
      pool.length ? format.format(pool.length) + " 道可抽题目" : "该范围暂时没有可抽的题";
  }
  return pool;
}

function latest(problem) {
  return state.history.findLast(entry => entry.problemId === problem.id);
}

function statusText(entry) {
  const points = earnedPoints(entry);
  if (entry.verdict === "pass") return points ? "通过，该题 +" + format.format(points) + " 分" : "通过，计入独立做对";
  if (entry.verdict === "skip") return "已认输，本题 +0 分";
  return "未通过，本次 +0 分";
}

function showVerdict(message, type = "") {
  const verdict = $("verdict");
  verdict.textContent = message;
  verdict.dataset.type = type;
  verdict.hidden = !message;
}

function showScore() {
  const tally = getScore(state.history);
  $("score").textContent = format.format(tally.score);
  $("solved").firstChild.textContent = tally.solved;
}

function renderMath(target, text) {
  target.textContent = text;
  renderMathInElement(target, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "\\[", right: "\\]", display: true },
      { left: "\\(", right: "\\)", display: false },
      { left: "$", right: "$", display: false }
    ],
    throwOnError: false,
    errorColor: "#ffc6d5",
    trust: false,
    maxExpand: 200,
    maxSize: 16
  });
}

function showAnswerPreview(show) {
  const preview = $("answer-preview");
  if (show) {
    if (answer.value.trim()) renderMath(preview, answer.value);
    else preview.textContent = "输入解题思路后，就可以在这里预览公式。行内公式用 $…$，独立公式用 $$…$$。";
  }
  answer.hidden = show;
  preview.hidden = !show;
  $("edit-answer").setAttribute("aria-pressed", String(!show));
  $("preview-answer").setAttribute("aria-pressed", String(show));
}

function updateEditor() {
  const completed = current && ["pass", "skip"].includes(latest(current)?.verdict);
  answer.disabled = !current || completed || busy;
  $("give-up").disabled = answer.disabled;
  $("submit-answer").disabled = answer.disabled || !answer.value.trim();
  reviewMode.disabled = busy;
  $("submit-answer").textContent = busy ? "正在评审…" : "提交评审";
  $("char-count").textContent = answer.value.length + " / 6000";
  showPool();
}

function showReviewMode() {
  const serverOption = reviewMode.querySelector('[value="server"]');
  const detailed = Boolean(current?.statement);
  serverOption.hidden = !autoJudge;
  serverOption.disabled = !autoJudge || !detailed;
  const preferred = [...reviewMode.options].find(option => option.value === state.reviewMode && !option.disabled);
  reviewMode.value = preferred?.value ?? (localIssue === "" && detailed ? "local" : "chatgpt");
  const note = $("review-note");
  const local = reviewMode.value === "local";
  $("retry-local").hidden = !local || !localIssue;
  if (local) {
    note.textContent = localIssue === undefined ? "正在检测浏览器的 WebGPU…" : localIssue ||
      (detailed || contextInput.value.trim()
    ? "首次评审下载约 1.1 GB 的模型，口胡在本设备处理。"
        : "请在题目卡片粘贴原题与数据范围，本机 Qwen 才能判断。");
  } else {
    note.textContent = current && !detailed && !contextInput.value.trim() ? "ChatGPT 评审会附上原题链接。" : "";
  }
  note.hidden = !note.textContent;
}

async function detectLocalReview() {
  localIssue = undefined;
  showReviewMode();
  localIssue = await localReviewAvailability();
  showReviewMode();
}

function draw() {
  const pool = showPool();
  if (!pool.length || busy) return;
  const next = chooseProblem(pool, state.seen, current?.id);
  if (next.id === current?.id) return;
  state.currentId = next.id;
  if (!state.seen.includes(next.id)) state.seen.push(next.id);
  save();
  renderProblem(next);
  return true;
}

function renderProblem(problem) {
  current = problem;
  const detailed = Boolean(problem?.statement);
  $("manual-fallback").hidden = true;
  $("empty-problem").hidden = Boolean(problem);
  $("problem-body").hidden = !detailed;
  $("linked-problem").hidden = !problem || detailed;
  $("problem-context").hidden = !problem || Boolean(problem.constraints);
  $("problem-context").open = false;
  contextInput.value = problem ? state.contexts[problem.id] ?? "" : "";
  $("problem-link").hidden = !problem;
  $("mirror-link").hidden = !problem?.mirror;
  $("problem-rating").hidden = !problem;
  $("mirror-rating").hidden = !problem?.mirror;
  if (problem) {
    $("problem-id").textContent = problem.platform + " / " + problem.id;
    $("problem-title").textContent = problem.title;
    const difficulty = luoguDifficulty(problem.difficulty);
    const rating = $("problem-rating");
    rating.textContent = difficulty ? "洛谷 " + difficulty.text : problem.platform === "Codeforces" ? "CF " + problem.rating : "AtCoder 估计 " + problem.estimate;
    rating.dataset.color = difficulty?.color ?? "";
    if (problem.mirror) {
      const mirror = luoguDifficulty(problem.mirror.difficulty);
      $("mirror-rating").textContent = "洛谷 " + mirror.text;
      $("mirror-rating").dataset.color = mirror.color;
      $("mirror-link").href = problem.mirror.url;
    }
    if (detailed) {
      renderMath($("statement"), problem.statement);
      $("constraints-box").hidden = !problem.constraints;
      renderMath($("constraints"), problem.constraints ?? "");
      renderMath($("example"), problem.example ?? "");
      $("example-box").hidden = !problem.example;
      $("example-box").open = false;
    }
    $("problem-link").href = problem.url;
    answer.value = state.drafts[problem.id] ?? "";
  } else {
    answer.value = "";
  }
  showAnswerPreview(false);
  showReviewMode();
  const entry = problem && latest(problem);
  showVerdict(entry ? statusText(entry) : "", entry?.verdict);
  updateEditor();
}

function record(verdict, source) {
  if (!current || ["pass", "skip"].includes(latest(current)?.verdict)) return;
  $("manual-fallback").hidden = true;
  const entry = { problemId: current.id, title: current.title, points: current.rating ?? 0, verdict, source, time: Date.now() };
  state.history.push(entry);
  save();
  showVerdict(statusText(entry), verdict);
  showScore();
  updateEditor();
  if (!$("history-view").hidden) viewHistory(true);
}

function viewHistory(show) {
  $("practice-view").hidden = show;
  $("history-view").hidden = !show;
  for (const [button, active] of [[$("practice-nav"), !show], [$("history-nav"), show]]) {
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (!show) return;
  $("history-empty").hidden = state.history.length > 0;
  const rows = [...state.history].reverse().map(entry => {
    const row = document.createElement("li");
    const left = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = entry.problemId + " · " + entry.title;
    const time = document.createElement("time");
    const method = { imported: " · 导入评审", "on-device": " · 本机 Qwen" }[entry.source] ?? "";
    time.textContent = dateFormat.format(entry.time) + method;
    const result = document.createElement("span");
    result.className = "history-result " + entry.verdict;
    result.textContent = statusText(entry);
    left.append(title, time);
    row.append(left, result);
    return row;
  });
  $("history-list").replaceChildren(...rows);
}

function showHandoff() {
  activeReview = { problemId: current.id, reviewId: crypto.randomUUID() };
  $("review-prompt").value = handoffPrompt(reviewProblem(), answer.value.trim(), activeReview.reviewId);
  $("review-result").value = "";
  $("copy-review").textContent = "复制评审内容";
  $("import-status").textContent = "";
  dialog.showModal();
}

function reviewProblem() {
  const pasted = contextInput.value.trim();
  return { ...current, statement: current.statement || pasted, constraints: current.constraints || (current.statement && pasted) || undefined };
}

async function submitLocal() {
  if (busy || !current || !answer.value.trim() || answer.disabled) return;
  const controller = new AbortController();
  localController = controller;
  busy = true;
  $("cancel-local").hidden = false;
  $("manual-fallback").hidden = true;
  showVerdict("正在加载本机模型…");
  updateEditor();
  try {
    const task = reviewProblem();
    let rubric;
    if (current.statement) {
      const response = await fetch("./rubrics.json?v=2", { signal: controller.signal });
      if (!response.ok) throw new Error("未能加载评审资料，可以改用 ChatGPT 评审。");
      rubric = (await response.json())[current.id];
    }
    const verdict = await reviewLocal({
      problem: task.statement,
      constraints: task.constraints,
      reference: rubric,
      submission: answer.value.trim()
    }, {
      signal: controller.signal,
      onProgress(progress) {
        if (Number.isFinite(progress)) showVerdict(progress >= 1
          ? "模型已就绪，正在本机评审…"
          : "正在准备本机模型 " + Math.round(Math.max(0, progress) * 100) + "%");
      }
    });
    if (verdict === "uncertain") throw new Error("本机模型无法确定，请用 ChatGPT 复核。");
    if (!["pass", "fail"].includes(verdict)) throw new Error("本机模型未返回有效判定。");
    record(verdict, "on-device");
  } catch (error) {
    showVerdict(controller.signal.aborted ? "已取消本机评审。" : (error.message || "本机评审暂不可用。"));
    $("manual-fallback").hidden = false;
  } finally {
    localController = undefined;
    $("cancel-local").hidden = true;
    busy = false;
    updateEditor();
  }
}

$("draw-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!draw()) return;
  const card = $("problem-card");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reducedMotion) card.animate([{ opacity: .55, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 240, easing: "ease-out" });
  if (matchMedia("(max-width: 670px)").matches) card.scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "start" });
});
$("draw-form").addEventListener("change", event => {
  if (event.target.id === "platform") loadDifficultyRange();
  const { platform, min, max, detailedOnly } = filters();
  state.filters = { platform, detailedOnly };
  if (platform !== "all") state.ranges[platform] = [min, max];
  save();
  showPool();
});
$("practice-nav").addEventListener("click", () => viewHistory(false));
$("history-nav").addEventListener("click", () => viewHistory(true));
reviewMode.addEventListener("change", () => {
  state.reviewMode = reviewMode.value;
  save();
  showReviewMode();
});
$("retry-local").addEventListener("click", () => void detectLocalReview());
contextInput.addEventListener("input", () => {
  if (!current) return;
  state.contexts[current.id] = contextInput.value;
  save();
  showReviewMode();
});
$("edit-answer").addEventListener("click", () => {
  showAnswerPreview(false);
  if (!answer.disabled) answer.focus();
});
$("preview-answer").addEventListener("click", () => showAnswerPreview(true));
answer.addEventListener("input", () => {
  if (current) {
    state.drafts[current.id] = answer.value;
    save();
  }
  updateEditor();
});
$("give-up").addEventListener("click", () => record("skip", "local"));
$("manual-fallback").addEventListener("click", () => {
  if (!answer.disabled && answer.value.trim()) showHandoff();
});
$("accept-local").addEventListener("click", () => {
  $("local-dialog").close();
  state.localDownloadApproved = true;
  save();
  void submitLocal();
});
$("decline-local").addEventListener("click", () => $("local-dialog").close());
$("cancel-local").addEventListener("click", () => localController?.abort());
$("close-review").addEventListener("click", () => dialog.close());
$("copy-review").addEventListener("click", async () => {
  const prompt = $("review-prompt");
  try {
    await navigator.clipboard.writeText(prompt.value);
    $("copy-review").textContent = "已复制";
  } catch {
    prompt.closest("details").open = true;
    prompt.focus();
    prompt.select();
    $("import-status").textContent = "请复制选中的文字。";
  }
});
$("import-form").addEventListener("submit", event => {
  event.preventDefault();
  try {
    const result = parseImportedReview($("review-result").value, activeReview);
    if (result === "uncertain") {
      $("import-status").textContent = "评审无法确认。可以在 ChatGPT 对话里贴上原题，再把新判定贴回这里。";
      return;
    }
    record(result, "imported");
    dialog.close();
  } catch (error) {
    $("import-status").textContent = error instanceof SyntaxError ? "请粘贴 ChatGPT 返回的完整判定。" : error.message;
  }
});
$("answer-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!current || !answer.value.trim() || busy || answer.disabled) return;
  if (reviewMode.value === "local") {
    if (localIssue !== "") {
      showVerdict(localIssue ?? "正在检测 WebGPU，请稍后再提交。");
      $("manual-fallback").hidden = false;
      return;
    }
    if (!reviewProblem().statement) {
      $("problem-context").open = true;
      contextInput.focus();
      showVerdict("请先补充原题与数据范围。");
      return;
    }
    if (state.localDownloadApproved) void submitLocal();
    else $("local-dialog").showModal();
    return;
  }
  if (reviewMode.value !== "server" || !autoJudge) { showHandoff(); return; }
  busy = true;
  $("manual-fallback").hidden = true;
  showVerdict("");
  updateEditor();
  try {
    const response = await fetch("/api/judge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problemId: current.id, answer: answer.value.trim() })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (!["pass", "fail"].includes(data.verdict)) throw new Error("评审结果格式有误，请重试。");
    record(data.verdict, "automatic");
  } catch (error) {
    showVerdict(error.message || "暂时无法评审，请稍后重试。");
    $("manual-fallback").hidden = false;
  } finally {
    busy = false;
    updateEditor();
  }
});

async function start() {
  showScore();
  if (state.filters) {
    const { platform, min, max, detailedOnly } = state.filters;
    if ([...$("platform").options].some(option => option.value === platform)) $("platform").value = platform;
    $("detailed-only").checked = detailedOnly !== false;
    if (platform === "Codeforces" && Number.isInteger(min) && Number.isInteger(max) && !state.ranges.Codeforces) {
      state.ranges.Codeforces = [min, max];
    }
  }
  loadDifficultyRange();
  try {
    const response = await fetch("./catalog.json?v=2");
    if (!response.ok) throw new Error("Catalog unavailable");
    const data = await response.json();
    problems = data.problems;
    autoJudge = data.autoJudge;
    for (const link of document.querySelectorAll('a[href="./source.zip"]')) link.hidden = !data.sourceDownload;
    $("owner-sign-in").hidden = !data.ownerSignIn;
    showReviewMode();
    void detectLocalReview();
    ready = true;
    const previous = problems.find(problem => problem.id === state.currentId);
    if (previous && (!$("detailed-only").checked || previous.statement || state.drafts[previous.id] || state.contexts[previous.id])) renderProblem(previous);
    else draw();
    showPool();
  } catch {
    $("pool-count").textContent = "题库加载失败，请刷新页面重试";
  }
}
start();
