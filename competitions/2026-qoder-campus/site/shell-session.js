function normalizeCommand(value) {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}\uFFFD]/gu, (char) => /\s/.test(char) ? " " : "");
  return cleaned.trim().replace(/\s+/g, " ");
}

export function formatCommandForDisplay(value) {
  return value.replace(/ /g, " · ");
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function normalizeOutputChunk(text, pending) {
  let clean = "";
  for (const char of text) {
    if (pending.ansiCarry) {
      pending.ansiCarry += char;
      if (/^\x1b\[[0-?]*[ -/]*[@-~]$/.test(pending.ansiCarry)) {
        pending.ansiCarry = "";
      } else if (!/^\x1b\[[0-?]*[ -/]*$/.test(pending.ansiCarry)) {
        clean += pending.ansiCarry;
        pending.ansiCarry = "";
      }
    } else if (char === "\x1b") {
      pending.ansiCarry = char;
    } else {
      clean += char;
    }
  }
  return clean.replace(/\r/g, "\n");
}

function findShellPrompt(text) {
  return /(?:^|\n)(?:\/(?:[\w./-]+)?|[A-Za-z0-9_.-]+\/(?:[\w./-]+)?)[%#] $/.exec(text);
}

function matchesExpect(expect, output) {
  if (!expect) return true;
  expect.lastIndex = 0;
  return expect.test(output);
}

export class ShellSession {
  constructor(tasks, { onChange = () => {} } = {}) {
    this.tasks = tasks;
    this.onChange = onChange;
    this.taskIndex = 0;
    this.executed = new Set();
    this.completed = new Set();
    this.inputBuffer = "";
    this.lineEdited = false;
    this.pending = null;
    this.pendingQueue = [];
    this.idleOutput = "";
    this.ansiCarry = "";
    this.knownCommands = new Set(tasks.flatMap((task) => task.steps.map((step) => step.command)));
    this.lastResult = null;
  }

  getTask(index = this.taskIndex) {
    return this.tasks[index];
  }

  getCurrentStepIndex() {
    const steps = this.getTask().steps;
    const firstPending = steps.findIndex((_, index) => !this.executed.has(this.stepKey(index)));
    return firstPending === -1 ? steps.length - 1 : firstPending;
  }

  getCurrentStep() {
    return this.getTask().steps[this.getCurrentStepIndex()];
  }

  getProgress() {
    return {
      completed: this.completed.size,
      executed: this.executed.size,
      total: this.tasks.length
    };
  }

  getTaskProgress(index = this.taskIndex) {
    const task = this.tasks[index];
    const executed = task.steps.filter((_, stepIndex) => this.executed.has(this.stepKey(stepIndex, index))).length;
    return { executed, total: task.steps.length };
  }

  isTaskComplete(taskId) {
    return this.completed.has(taskId);
  }

  applyServerProgress(stepIds) {
    const completed = new Set(stepIds);
    this.tasks.forEach((task, taskIndex) => {
      task.steps.forEach((_, stepIndex) => {
        const key = this.stepKey(stepIndex, taskIndex);
        if (completed.has(key)) this.executed.add(key);
      });
      if (task.steps.every((_, stepIndex) => this.executed.has(this.stepKey(stepIndex, taskIndex)))) {
        this.completed.add(task.id);
      }
    });
    this.notify();
  }

  isBusy() {
    return this.pending !== null || this.pendingQueue.length > 0;
  }

  selectTask(index) {
    if (index < 0 || index >= this.tasks.length || this.isBusy()) return false;
    this.taskIndex = index;
    this.lastResult = null;
    this.notify();
    return true;
  }

  fillHint() {
    if (this.isBusy()) return { ok: false, reason: "command-pending" };
    if (this.lineEdited) return { ok: false, reason: "line-edited" };
    if (this.inputBuffer) return { ok: false, reason: "input-not-empty" };
    const command = this.getCurrentStep().command;
    this.inputBuffer = command;
    return { ok: true, command };
  }

  observeInput(data) {
    const clean = stripAnsi(data);
    if (clean !== data || data.includes("\t") || /[\x01\x05\x15\x17]/.test(data)) {
      this.lineEdited = true;
      this.inputBuffer = "";
    }
    for (const char of clean) {
      if (char === "\r") {
        this.submit();
      } else if (char === "\n") {
        if (this.inputBuffer || this.lineEdited) this.submit();
      } else if (char === "\x7f" || char === "\b") {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
      } else if (char === "\x03") {
        this.inputBuffer = "";
        this.lineEdited = false;
        this.pending = null;
        this.pendingQueue = [];
        this.idleOutput = "";
        this.ansiCarry = "";
        this.lastResult = { status: "cancelled" };
        this.notify();
      } else if (char === "\x0c" || char === "\t" || /[\x01\x05\x15\x17]/.test(char)) {
        this.lineEdited = true;
        this.inputBuffer = "";
      } else if (char >= " ") {
        this.inputBuffer += char;
      }
    }
  }

  observeOutput(text) {
    if (!this.pending) {
      this.idleOutput = `${this.idleOutput}${normalizeOutputChunk(text, this)}`.slice(-2048);
      const prompt = findShellPrompt(this.idleOutput);
      if (prompt) this.idleOutput = this.idleOutput.slice(prompt.index + prompt[0].length);
      return;
    }
    let remaining = normalizeOutputChunk(text, this.pending);
    while (remaining && this.pending) {
      this.pending.output += remaining;
      this.captureEcho();
      const prompt = findShellPrompt(this.pending.output);
      if (!prompt) return;
      const promptEnd = prompt.index + prompt[0].length;
      remaining = this.pending.output.slice(promptEnd);
      this.pending.output = this.pending.output.slice(0, promptEnd);
      this.finishPending();
    }
  }

  captureEcho() {
    if (!this.pending || this.pending.echoCaptured) return;
    const clean = this.pending.output.replace(/^\n+/, "");
    const newline = clean.indexOf("\n");
    if (newline === -1) return;
    const firstLine = clean.slice(0, newline).trim()
      .replace(/^(?:\/(?:[\w./-]+)?|[A-Za-z0-9_.-]+\/(?:[\w./-]+)?)[%#]\s+/, "");
    if (!firstLine) return;
    const echoed = normalizeCommand(firstLine);
    const matchesSubmitted = this.pending.command && echoed === this.pending.command;
    const matchesEditedCommand = this.pending.lineEdited && this.knownCommands.has(echoed);
    if (this.pending.echoSeeded || matchesSubmitted || matchesEditedCommand) {
      this.pending.command = echoed;
      this.pending.echoCaptured = true;
    }
  }

  getPending() {
    return this.pending;
  }

  getLastResult() {
    return this.lastResult;
  }

  restartLearning() {
    this.taskIndex = 0;
    this.executed.clear();
    this.completed.clear();
    this.inputBuffer = "";
    this.lineEdited = false;
    this.pending = null;
    this.pendingQueue = [];
    this.idleOutput = "";
    this.ansiCarry = "";
    this.lastResult = null;
    this.notify();
  }

  stepKey(stepIndex, taskIndex = this.taskIndex) {
    const step = this.tasks[taskIndex].steps[stepIndex];
    return step.id || `${this.tasks[taskIndex].id}:${stepIndex}`;
  }

  submit() {
    const command = normalizeCommand(this.inputBuffer);
    const lineEdited = this.lineEdited;
    this.inputBuffer = "";
    this.lineEdited = false;
    if (!command && !lineEdited) return;
    const queued = { command, lineEdited };
    if (this.pending) {
      this.pendingQueue.push(queued);
    } else {
      this.beginPending(queued);
    }
    this.notify();
  }

  beginPending({ command, lineEdited }) {
    const taskIndex = this.taskIndex;
    const stepIndex = this.getCurrentStepIndex();
    const pending = {
      command,
      expected: this.getCurrentStep().command,
      taskId: this.getTask().id,
      taskIndex,
      stepIndex,
      startedAt: Date.now(),
      output: this.idleOutput,
      ansiCarry: this.ansiCarry,
      echoCaptured: false,
      echoSeeded: normalizeCommand(this.idleOutput) !== "",
      lineEdited
    };
    this.idleOutput = "";
    this.ansiCarry = "";
    this.pending = pending;
  }

  startNextPending() {
    const next = this.pendingQueue.shift();
    if (!next) return false;
    this.beginPending(next);
    this.notify();
    return true;
  }

  finishPending() {
    this.captureEcho();
    const pending = this.pending;
    this.pending = null;
    const task = this.tasks[pending.taskIndex];
    const commandMatches = pending.command === pending.expected;
    let outputForCheck = pending.output
      .replace(/(?:^|\n)(?:\/(?:[\w./-]+)?|[A-Za-z0-9_.-]+\/(?:[\w./-]+)?)[%#] $/, "");
    if (pending.echoCaptured) {
      const newline = outputForCheck.indexOf("\n");
      if (newline !== -1) {
        outputForCheck = outputForCheck.slice(newline + 1);
      } else if (outputForCheck.startsWith(pending.command)) {
        outputForCheck = outputForCheck.slice(pending.command.length);
      }
    }
    const outputMatches = commandMatches && matchesExpect(task.steps[pending.stepIndex].expect, outputForCheck);
    const status = !commandMatches ? "mismatch" : outputMatches ? "success" : "output-mismatch";
    if (status === "success") {
      this.executed.add(this.stepKey(pending.stepIndex, pending.taskIndex));
      if (task.steps.every((_, index) => this.executed.has(this.stepKey(index, pending.taskIndex)))) {
        this.completed.add(task.id);
      }
    }
    this.lastResult = { ...pending, status };
    this.notify();
    this.startNextPending();
  }

  notify() {
    this.onChange({
      taskIndex: this.taskIndex,
      stepIndex: this.getCurrentStepIndex(),
      progress: this.getProgress(),
      lastResult: this.lastResult
    });
  }
}
