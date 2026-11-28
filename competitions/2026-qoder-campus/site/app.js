import { hasShellPrompt, V86Runtime } from "./v86-runtime.js?v=20261127l";
import { formatCommandForDisplay, ShellSession } from "./shell-session.js?v=20261127l";
import { tasks as bundledTasks } from "./lesson-tasks.js?v=20261127l";
import { ensureSession, loadServerProgress, loadTaskCatalog, reportAttempt, resetServerProgress } from "./api-client.js?v=20261127l";
import { createTaskQueue } from "./task-queue.js?v=20261127l";

let tasks = bundledTasks;
let totalSteps = tasks.reduce((total, task) => total + task.steps.length, 0);
let catalogSource = "local";
let progressSyncState = "local";
const progressQueue = createTaskQueue();
let restartingLearning = false;
let panelOpen = false;
let panelCollapsed = false;
let panelDock = "right";

const elements = {
  announcer: document.querySelector("#announcer"),
  commandCount: document.querySelector("#command-count"),
  catalogStatus: document.querySelector("#catalog-status"),
  packCount: document.querySelector("#pack-count"),
  openPack: document.querySelector("#open-pack"),
  packDialog: document.querySelector("#pack-dialog"),
  packGrid: document.querySelector("#pack-grid"),
  closePack: document.querySelector("#close-pack"),
  taskPanel: document.querySelector("#task-panel"),
  panelTab: document.querySelector("#panel-tab"),
  changePack: document.querySelector("#change-pack"),
  collapsePanel: document.querySelector("#collapse-panel"),
  dockPanel: document.querySelector("#dock-panel"),
  closePanel: document.querySelector("#close-panel"),
  taskCategory: document.querySelector("#task-category"),
  taskDifficulty: document.querySelector("#task-difficulty"),
  taskPanelTitle: document.querySelector("#task-panel-title"),
  taskPanelGoal: document.querySelector("#task-panel-goal"),
  taskDuration: document.querySelector("#task-duration"),
  taskStepCount: document.querySelector("#task-step-count"),
  taskProgressLabel: document.querySelector("#task-progress-label"),
  taskStepList: document.querySelector("#task-step-list"),
  taskList: document.querySelector("#task-list"),
  progressCount: document.querySelector("#progress-count"),
  progressFill: document.querySelector("#progress-fill"),
  terminalTitle: document.querySelector("#terminal-title"),
  terminalSubtitle: document.querySelector("#terminal-subtitle"),
  terminalGoal: document.querySelector("#terminal-goal"),
  terminalMount: document.querySelector("#terminal-mount"),
  runtimeStatus: document.querySelector("#runtime-status"),
  runtimeGuideLabel: document.querySelector("#runtime-guide-label"),
  runtimeGuideText: document.querySelector("#runtime-guide-text"),
  resetTask: document.querySelector("#reset-task"),
  retryRuntime: document.querySelector("#retry-runtime"),
  hintButton: document.querySelector("#hint-button"),
  explainEmpty: document.querySelector("#explain-empty"),
  explainContent: document.querySelector("#explain-content"),
  explainCommand: document.querySelector("#explain-command"),
  commandTokens: document.querySelector("#command-tokens"),
  explainHeading: document.querySelector("#explain-heading"),
  explainBody: document.querySelector("#explain-body"),
  explainMeaning: document.querySelector("#explain-meaning"),
  explainNext: document.querySelector("#explain-next"),
  cardNumber: document.querySelector("#card-number"),
  receiptStatus: document.querySelector("#receipt-status"),
  learningComplete: document.querySelector("#learning-complete"),
  recapList: document.querySelector("#recap-list"),
  restartLearning: document.querySelector("#restart-learning")
};

let terminal;
let runtime;
let session;
let runtimePhase = "loading";
let serialTail = "";
let loginTimer = null;
let startingRuntime = false;
let terminalCleanup = () => {};
let announceTimer = null;
let lastProgressAnnouncement = "";
let lastAnnouncedResult = null;
let lastSyncedResult = null;
let completionAnnounced = false;

function announce(message) {
  clearTimeout(announceTimer);
  elements.announcer.textContent = "";
  announceTimer = setTimeout(() => {
    elements.announcer.textContent = message;
  }, 30);
}

async function syncAttempt(result) {
  if (catalogSource !== "server" || progressSyncState !== "connected") return;
  const taskIndex = tasks.findIndex((task) => task.id === result.taskId);
  const step = tasks[taskIndex]?.steps[result.stepIndex];
  if (!step) return;
  const response = await progressQueue.run(() => reportAttempt({
    attemptId: crypto.randomUUID(),
    taskId: result.taskId,
    stepId: step.id,
    command: result.command,
    output: result.output,
    durationMs: Math.max(0, Date.now() - result.startedAt)
  }));
  progressSyncState = response ? "connected" : "local";
  renderCatalogMeta();
}

function handleSessionChange() {
  renderLearningState();
  const result = session.getLastResult();
  if (result && result !== lastSyncedResult && result.status !== "cancelled") {
    lastSyncedResult = result;
    void syncAttempt(result);
  }
}

function currentTask() {
  return session.getTask();
}

function currentStep() {
  return session.getCurrentStep();
}

function renderCatalogMeta() {
  elements.commandCount.textContent = String(totalSteps).padStart(2, "0");
  elements.packCount.textContent = `${tasks.length} 个卡包`;
  elements.catalogStatus.textContent = catalogSource === "server"
    ? progressSyncState === "connected" ? "云端目录 · 匿名进度已连接" : "云端目录 · 进度仅本机"
    : "本地目录 · 后端未连接";
}

function renderPackGrid() {
  elements.packGrid.replaceChildren();
  tasks.forEach((task, index) => {
    const complete = session?.isTaskComplete(task.id) || false;
    const progress = session?.getTaskProgress(index) || { executed: 0, total: task.steps.length };
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pack-card";
    button.dataset.accent = task.accent || "cyan";
    button.dataset.complete = String(complete);
    button.style.setProperty("--card-accent", `var(--accent-${task.accent || "cyan"})`);
    button.setAttribute("aria-label", `${task.name}，${task.category}，${progress.executed}/${progress.total} 步`);
    const top = document.createElement("span");
    top.className = "pack-card-top";
    const number = document.createElement("strong");
    number.textContent = task.number;
    const category = document.createElement("span");
    category.textContent = task.category;
    top.append(number, category);
    const title = document.createElement("h3");
    title.textContent = task.name;
    const description = document.createElement("p");
    description.textContent = task.description;
    const footer = document.createElement("span");
    footer.className = "pack-card-footer";
    const duration = document.createElement("small");
    duration.textContent = `${task.durationMinutes || 6} 分钟`;
    const state = document.createElement("small");
    state.textContent = complete ? "已完成" : `${progress.executed}/${progress.total} 步`;
    footer.append(duration, state);
    button.append(top, title, description, footer);
    button.addEventListener("click", () => drawTask(index));
    elements.packGrid.append(button);
  });
}

function openPackDialog() {
  renderPackGrid();
  elements.packDialog.showModal();
  elements.openPack.setAttribute("aria-expanded", "true");
}

function closePackDialog() {
  elements.packDialog.close();
  elements.openPack.setAttribute("aria-expanded", "false");
}

function drawTask(index) {
  if (!session) return;
  if (session.isBusy()) {
    announce("命令执行中，暂不能切换任务。");
    return;
  }
  closePackDialog();
  selectTask(index);
  openTaskPanel();
  elements.taskPanel.classList.add("is-drawing");
  setTimeout(() => elements.taskPanel.classList.remove("is-drawing"), 360);
  announce(`已抽取任务卡：${tasks[index].name}`);
}

function renderTaskOverview() {
  const task = currentTask();
  const progress = session.getTaskProgress();
  elements.taskCategory.textContent = task.category || "基础";
  elements.taskDifficulty.textContent = ["入门", "基础", "进阶"][Math.min(2, Math.max(0, (task.difficulty || 1) - 1))];
  elements.taskPanelTitle.textContent = task.name;
  elements.taskPanelGoal.textContent = task.goal;
  elements.taskDuration.textContent = `${task.durationMinutes || 6} 分钟`;
  elements.taskStepCount.textContent = `${task.steps.length} 步`;
  elements.taskProgressLabel.textContent = `${progress.executed}/${progress.total}`;
  elements.taskPanel.style.setProperty("--task-accent", `var(--accent-${task.accent || "cyan"})`);
  elements.taskPanel.dataset.accent = task.accent || "cyan";
  elements.taskStepList.replaceChildren();
  task.steps.forEach((step, index) => {
    const item = document.createElement("li");
    const complete = session.executed.has(session.stepKey(index));
    item.dataset.complete = String(complete);
    const marker = document.createElement("span");
    marker.textContent = complete ? "✓" : String(index + 1).padStart(2, "0");
    const copy = document.createElement("span");
    const command = document.createElement("code");
    command.textContent = step.command;
    const heading = document.createElement("small");
    heading.textContent = step.heading;
    copy.append(command, heading);
    item.append(marker, copy);
    elements.taskStepList.append(item);
  });
}

function syncPanelState() {
  elements.taskPanel.hidden = !panelOpen;
  elements.taskPanel.dataset.open = String(panelOpen);
  elements.taskPanel.dataset.collapsed = String(panelCollapsed);
  elements.taskPanel.dataset.dock = panelDock;
  elements.panelTab.hidden = panelOpen;
  elements.collapsePanel.setAttribute("aria-expanded", String(!panelCollapsed));
  elements.collapsePanel.textContent = panelCollapsed ? "+" : "−";
  elements.dockPanel.setAttribute("aria-pressed", String(panelDock === "left"));
  elements.dockPanel.setAttribute("aria-label", panelDock === "left" ? "停靠到右侧" : "停靠到左侧");
  const workspace = document.querySelector("#workspace");
  workspace.classList.toggle("dock-left", panelDock === "left");
  workspace.classList.toggle("panel-closed", !panelOpen);
  workspace.classList.toggle("panel-collapsed", panelOpen && panelCollapsed);
}

function openTaskPanel() {
  panelOpen = true;
  panelCollapsed = false;
  syncPanelState();
  renderTaskOverview();
}

function togglePanelCollapse() {
  if (!panelOpen) {
    openTaskPanel();
    return;
  }
  panelCollapsed = !panelCollapsed;
  syncPanelState();
  announce(panelCollapsed ? "任务卡已折叠" : "任务卡已展开");
}

function togglePanelDock() {
  panelDock = panelDock === "right" ? "left" : "right";
  if (!panelOpen) openTaskPanel();
  syncPanelState();
  announce(panelDock === "left" ? "任务卡已停靠左侧" : "任务卡已停靠右侧");
}

function closeTaskPanel() {
  panelOpen = false;
  panelCollapsed = false;
  syncPanelState();
  elements.panelTab.focus();
}

function renderTasks() {
  elements.taskList.setAttribute("aria-busy", String(session.isBusy()));
  const active = document.activeElement;
  const focusedIndex = active?.classList.contains("task-button")
    ? Number(active.dataset.taskIndex)
    : null;
  elements.taskList.replaceChildren();
  tasks.forEach((task, index) => {
    const button = document.createElement("button");
    const complete = session.isTaskComplete(task.id);
    const progress = session.getTaskProgress(index);
    button.type = "button";
    button.className = "task-button";
    button.dataset.taskIndex = String(index);
    button.dataset.complete = String(complete);
    button.dataset.accent = task.accent || "cyan";
    button.style.setProperty("--task-accent", `var(--accent-${task.accent || "cyan"})`);
    button.setAttribute("aria-current", index === session.taskIndex ? "step" : "false");
    const taskIndexElement = document.createElement("span");
    taskIndexElement.className = "task-index";
    taskIndexElement.textContent = complete ? "✓" : task.number;
    const copy = document.createElement("span");
    const name = document.createElement("span");
    name.className = "task-name";
    name.textContent = task.name;
    const description = document.createElement("span");
    description.className = "task-desc";
    description.textContent = complete ? "已完成" : `${progress.executed}/${progress.total} 步 · ${task.description}`;
    copy.append(name, description);
    button.append(taskIndexElement, copy);
    button.addEventListener("click", () => selectTask(index));
    elements.taskList.append(button);
  });
  if (focusedIndex !== null) elements.taskList.children[focusedIndex]?.focus({ preventScroll: true });
}

function renderProgress() {
  const progress = session.getProgress();
  const label = `${progress.completed} / ${progress.total} 已完成`;
  elements.progressCount.textContent = label;
  elements.progressFill.style.width = `${(progress.completed / progress.total) * 100}%`;
  if (label !== lastProgressAnnouncement) {
    lastProgressAnnouncement = label;
    announce(label);
  }
}

function renderTaskHeader() {
  const task = currentTask();
  const stepIndex = session.getCurrentStepIndex();
  elements.terminalTitle.textContent = `任务 ${task.number} · ${task.name} · ${stepIndex + 1}/${task.steps.length}`;
  elements.terminalSubtitle.textContent = "Buildroot 2013.08.1 · 32 位 i686 · xterm.js + v86";
  elements.terminalGoal.textContent = task.goal;
}

function resetExplanation() {
  elements.explainEmpty.hidden = false;
  elements.explainContent.hidden = true;
  elements.cardNumber.textContent = "—";
  elements.receiptStatus.textContent = "已填入";
  delete elements.explainCommand.dataset.command;
  elements.commandTokens.replaceChildren();
}

function renderCommandTokens(command) {
  elements.commandTokens.replaceChildren();
  const tokens = command.match(/[^\s"']+|"[^"]*"|'[^']*'/g) || [];
  tokens.forEach((token, index) => {
    const element = document.createElement("span");
    element.textContent = token;
    element.className = index === 0
      ? "token-command"
      : /^(\||>|<|&&|\|\||;)$/.test(token)
        ? "token-operator"
        : token.startsWith("-")
          ? "token-option"
          : "token-arg";
    elements.commandTokens.append(element);
  });
}

function showExplanation(step, status, stepIndex) {
  elements.explainEmpty.hidden = true;
  elements.explainContent.hidden = false;
  elements.explainCommand.textContent = formatCommandForDisplay(step.command);
  elements.explainCommand.setAttribute("aria-label", step.command);
  elements.explainCommand.dataset.command = step.command;
  elements.explainCommand.title = "命令中的 · 表示空格";
  renderCommandTokens(step.command);
  elements.explainHeading.textContent = step.heading;
  elements.explainBody.textContent = step.body;
  elements.explainMeaning.textContent = step.meaning;
  elements.explainNext.textContent = step.next;
  elements.cardNumber.textContent = `${currentTask().number}.${stepIndex + 1}`;
  elements.receiptStatus.textContent = status;
}

function showResult(result) {
  if (result.status === "cancelled") {
    resetExplanation();
    return;
  }
  const taskIndex = tasks.findIndex((task) => task.id === result.taskId);
  const step = tasks[taskIndex].steps[result.stepIndex];
  if (result.status === "success") {
    showExplanation(step, "已执行", result.stepIndex);
    return;
  }
  elements.explainEmpty.hidden = true;
  elements.explainContent.hidden = false;
  elements.explainCommand.textContent = formatCommandForDisplay(result.command);
  elements.explainCommand.setAttribute("aria-label", result.command);
  elements.explainCommand.dataset.command = result.command;
  elements.explainCommand.title = "命令中的 · 表示空格";
  renderCommandTokens(result.command);
  elements.explainHeading.textContent = result.status === "mismatch" ? "命令与当前目标不一致" : "命令执行了，但输出证据不足";
  elements.explainBody.textContent = `当前步骤需要：${step.command}`;
  elements.explainMeaning.textContent = result.status === "mismatch"
    ? `你执行了 ${result.command}。这次没有推进学习状态。`
    : "命令已返回提示符，但结果里没有本步骤要求的关键证据。";
  elements.explainNext.textContent = "查看真实输出，修正命令或目标后再试一次。";
  elements.cardNumber.textContent = `${tasks[taskIndex].number}.${result.stepIndex + 1}`;
  elements.receiptStatus.textContent = "未通过";
}

function renderCompletion() {
  const allComplete = session.getProgress().completed === tasks.length;
  elements.learningComplete.hidden = !allComplete;
  if (!allComplete) {
    completionAnnounced = false;
    return;
  }
  elements.recapList.replaceChildren();
  tasks.forEach((task) => {
    task.steps.forEach((step, index) => {
      const item = document.createElement("div");
      item.className = "recap-item";
      const code = document.createElement("code");
      code.textContent = step.command;
      const label = document.createElement("span");
      label.textContent = `${task.number}.${index + 1} ${step.heading}`;
      item.append(code, label);
      elements.recapList.append(item);
    });
  });
  if (!completionAnnounced) {
    completionAnnounced = true;
    announce(`练习完成，${tasks.length} 个卡包共 ${totalSteps} 条命令已全部执行。`);
  }
}

function renderLearningState() {
  renderCatalogMeta();
  renderTasks();
  renderProgress();
  renderTaskHeader();
  renderTaskOverview();
  elements.hintButton.textContent = `填入 ${currentStep().command}`;
  elements.hintButton.disabled = runtimePhase !== "ready" || session.isBusy() || session.isTaskComplete(currentTask().id);
  const result = session.getLastResult();
  if (result && result !== lastAnnouncedResult) {
    lastAnnouncedResult = result;
    if (result.status === "cancelled") {
      announce("已取消当前命令。");
    } else if (result.status === "success") {
      announce(`命令 ${result.command} 已执行，已完成 ${session.getProgress().executed} / ${totalSteps} 步。`);
    } else if (result.status === "mismatch") {
      announce(`命令 ${result.command} 与当前目标不一致，未推进。`);
    } else {
      announce(`命令 ${result.command} 已返回，但输出证据不足，未推进。`);
    }
  }
  if (result) showResult(result);
  renderCompletion();
}

function selectTask(index) {
  const hadTaskFocus = document.activeElement?.classList.contains("task-button");
  if (!session.selectTask(index)) {
    announce("命令执行中，暂不能切换任务。");
    return;
  }
  renderLearningState();
  resetExplanation();
  openTaskPanel();
  if (hadTaskFocus) elements.taskList.children[index]?.focus();
}

function setRuntimePhase(phase, text) {
  runtimePhase = phase;
  elements.runtimeStatus.textContent = text;
  announce(text);
  elements.terminalMount.dataset.state = phase;
  const ready = phase === "ready";
  elements.hintButton.disabled = !ready;
  elements.resetTask.disabled = !ready;
  elements.retryRuntime.hidden = phase !== "error" && phase !== "stopped";
  if (ready) {
    elements.terminalMount.dataset.baseline = "ready";
  } else {
    delete elements.terminalMount.dataset.baseline;
  }
  const guideLabels = {
    loading: "运行时",
    booting: "启动中",
    "awaiting-login": "首次登录",
    saving: "保存基线",
    ready: "环境就绪",
    resetting: "重置中",
    stopped: "已停止",
    error: "需要重试"
  };
  elements.runtimeGuideLabel.textContent = guideLabels[phase] || "运行时";
  const guides = {
    loading: "正在加载本地 Linux 镜像与运行时。",
    booting: "正在启动 Buildroot Linux，请稍候。",
    "awaiting-login": "在 login: 后输入 root，无需密码；仅限隔离客户机。",
    saving: "正在保存干净的 Linux 基线，暂时关闭命令输入。",
    ready: "基线已就绪 · Buildroot 2013.08.1 / 32 位 / 无 systemd、stat。命令卡只填入，按 Enter 执行。",
    resetting: "正在恢复 Linux 基线，暂时关闭命令输入。",
    stopped: "Linux 客户机已停止。点击“重新加载”重试。",
    error: "运行时发生错误。点击“重新加载”重试。"
  };
  elements.runtimeGuideText.textContent = guides[phase] || text;
  if (session) renderLearningState();
}

function sendHint() {
  if (runtimePhase !== "ready" || session.isBusy() || session.isTaskComplete(currentTask().id)) return;
  const result = session.fillHint();
  if (!result.ok) return;
  runtime.write(result.command);
  showExplanation(currentStep(), "已填入", session.getCurrentStepIndex());
  announce(`已填入命令 ${result.command}，按 Enter 执行。`);
  terminal.focus();
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function captureBaseline() {
  if (runtimePhase !== "awaiting-login") return;
  clearTimeout(loginTimer);
  loginTimer = null;
  setRuntimePhase("saving", "正在保存 Linux 基线…");
  try {
    await withTimeout(runtime.captureBaseline(), 10000, "保存 Linux 基线超时");
    setRuntimePhase("ready", "Linux 已就绪，可以输入命令或重置环境。");
  } catch (error) {
    setRuntimePhase("error", `保存基线失败：${error.message}`);
  }
}

async function resetRuntime() {
  if (runtimePhase !== "ready") return;
  if (session.isBusy()) {
    announce("命令执行中，暂不能重置环境。");
    return;
  }
  session.selectTask(session.taskIndex);
  renderLearningState();
  resetExplanation();
  setRuntimePhase("resetting", "正在恢复 Linux 基线…");
  try {
    await withTimeout(runtime.reset(), 10000, "重置 Linux 基线超时");
    terminal.reset();
    runtime.write("\n");
    setRuntimePhase("ready", "已恢复基线，学习进度已保留。");
  } catch (error) {
    setRuntimePhase("error", `重置失败：${error.message}`);
    return;
  }
  terminal.focus();
}

async function restartLearning() {
  if (runtimePhase !== "ready" || restartingLearning) return;
  restartingLearning = true;
  session.restartLearning();
  lastSyncedResult = null;
  renderLearningState();
  resetExplanation();
  setRuntimePhase("resetting", "正在清除匿名学习进度…");
  try {
    if (catalogSource === "server" && progressSyncState === "connected") {
      const response = await progressQueue.run(() => resetServerProgress());
      if (!response) throw new Error("进度清除失败");
    }
    await withTimeout(runtime.reset(), 10000, "重置 Linux 基线超时");
    terminal.reset();
    runtime.write("\n");
    setRuntimePhase("ready", "学习进度已清空，可以重新抽取任务卡。");
  } catch (error) {
    setRuntimePhase("error", `重新开始失败：${error.message}`);
  } finally {
    restartingLearning = false;
    if (runtimePhase === "ready") terminal.focus();
  }
}

function createTerminal() {
  terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    screenReaderMode: true,
    fontFamily: '"JetBrains Mono", "Noto Sans SC", "Microsoft YaHei", monospace',
    fontSize: 14,
    scrollback: 2000,
    theme: {
      background: "#08090a",
      foreground: "#e7e9ec",
      cursor: "#f3f4f5",
      selectionBackground: "#3a3f46"
    }
  });
  const fitAddon = new window.FitAddon.FitAddon();
  const resizeHandler = () => requestAnimationFrame(() => fitAddon.fit());
  const resizeObserver = new ResizeObserver(resizeHandler);
  terminal.loadAddon(fitAddon);
  terminal.open(elements.terminalMount);
  fitAddon.fit();
  resizeObserver.observe(elements.terminalMount);
  window.addEventListener("resize", resizeHandler);
  document.fonts.ready.then(() => fitAddon.fit());
  terminalCleanup = () => {
    resizeObserver.disconnect();
    window.removeEventListener("resize", resizeHandler);
    terminal.dispose();
  };
}

function scheduleLoginTimeout() {
  clearTimeout(loginTimer);
  loginTimer = setTimeout(() => {
    if (runtimePhase === "awaiting-login") {
      setRuntimePhase("error", "登录超时：请在 login: 后输入 root，或点击重新加载。");
    }
  }, 120000);
}

async function preflightAssets(paths, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await Promise.all(paths.map(async (path) => {
      const response = await fetch(path, { method: "HEAD", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`资源加载失败：${path}（HTTP ${response.status}）`);
    }));
  } catch (error) {
    if (controller.signal.aborted) throw new Error("资源预检超时，请检查网络后重试");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function startRuntime() {
  if (startingRuntime) return;
  startingRuntime = true;
  renderLearningState();
  setRuntimePhase("booting", "正在加载 Linux 镜像…");
  try {
    await preflightAssets([
      "assets/vendor/v86/libv86.js",
      "assets/vendor/v86/v86.wasm",
      "assets/vendor/v86/seabios.bin",
      "assets/vendor/v86/vgabios.bin",
      "assets/images/linux.iso"
    ]);
    if (typeof window.V86 !== "function") throw new Error("v86 运行时未加载");
    runtime = new V86Runtime({
      V86Ctor: window.V86,
      wasmPath: "assets/vendor/v86/v86.wasm",
      biosPath: "assets/vendor/v86/seabios.bin",
      vgaBiosPath: "assets/vendor/v86/vgabios.bin",
      imagePath: "assets/images/linux.iso",
      memorySize: 64 * 1024 * 1024,
      startTimeoutMs: 20000,
      onStopped: () => {
        if (runtimePhase !== "resetting") setRuntimePhase("stopped", "Linux 客户机已停止。");
      },
      onData: (data) => {
        terminal.write(data);
        session.observeOutput(data);
        serialTail = `${serialTail}${data}`.slice(-512);
        if (runtimePhase === "awaiting-login" && hasShellPrompt(serialTail)) captureBaseline();
      }
    });
    terminal.onData((data) => {
      if (runtimePhase === "awaiting-login") {
        scheduleLoginTimeout();
        try {
          runtime.write(data);
        } catch (error) {
          setRuntimePhase("error", `登录输入失败：${error.message}`);
        }
        return;
      }
      if (runtimePhase !== "ready") return;
      session.observeInput(data);
      try {
        runtime.write(data);
      } catch (error) {
        setRuntimePhase("error", `命令输入失败：${error.message}`);
      }
    });
    await runtime.start();
    setRuntimePhase("awaiting-login", "Linux 内核已启动，等待登录提示符。");
    scheduleLoginTimeout();
    if (hasShellPrompt(serialTail)) captureBaseline();
  } catch (error) {
    setRuntimePhase("error", `Linux 启动失败：${error.message}`);
  } finally {
    startingRuntime = false;
  }
}

createTerminal();
syncPanelState();
setRuntimePhase("loading", "正在加载 Linux 镜像…");
elements.hintButton.addEventListener("click", sendHint);
elements.openPack.addEventListener("click", openPackDialog);
elements.changePack.addEventListener("click", openPackDialog);
elements.closePack.addEventListener("click", closePackDialog);
elements.packDialog.addEventListener("close", () => elements.openPack.setAttribute("aria-expanded", "false"));
elements.panelTab.addEventListener("click", openTaskPanel);
elements.collapsePanel.addEventListener("click", togglePanelCollapse);
elements.dockPanel.addEventListener("click", togglePanelDock);
elements.closePanel.addEventListener("click", closeTaskPanel);
elements.resetTask.addEventListener("click", resetRuntime);
elements.retryRuntime.addEventListener("click", () => location.reload());
elements.restartLearning.addEventListener("click", () => {
  void restartLearning();
});
window.addEventListener("pagehide", () => {
  clearTimeout(loginTimer);
  clearTimeout(announceTimer);
  if (runtime) runtime.destroy();
  terminalCleanup();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

async function bootstrap() {
  const catalog = await loadTaskCatalog();
  tasks = catalog.tasks;
  totalSteps = tasks.reduce((total, task) => total + task.steps.length, 0);
  catalogSource = catalog.source;
  const sessionResponse = catalogSource === "server" ? await ensureSession() : null;
  const serverProgress = sessionResponse ? await loadServerProgress() : null;
  progressSyncState = sessionResponse && serverProgress ? "connected" : "local";
  session = new ShellSession(tasks, { onChange: handleSessionChange });
  if (serverProgress?.completed) session.applyServerProgress(serverProgress.completed.map((item) => item.stepId));
  renderLearningState();
  startRuntime();
}

void bootstrap();
