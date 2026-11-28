import test from "node:test";
import assert from "node:assert/strict";
import { hasShellPrompt, V86Runtime } from "../v86-runtime.js";

class FakeV86 {
  constructor(options) {
    this.options = options;
    this.listeners = new Map();
    this.sent = [];
    this.sentBytes = [];
    this.restored = [];
    this.runCount = 0;
    this.destroyCount = 0;
    this.saveCount = 0;
    this.restoreCount = 0;
    this.state = new Uint8Array([1, 2, 3]);
    queueMicrotask(() => this.emit("emulator-started"));
  }

  add_listener(event, listener) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event, value) {
    for (const listener of this.listeners.get(event) || []) listener(value);
  }

  serial0_send(data) {
    this.sent.push(data);
  }

  serial_send_bytes(port, bytes) {
    this.sentBytes.push({ port, bytes: Array.from(bytes) });
  }

  async save_state() {
    this.saveCount += 1;
    return this.state.slice();
  }

  async restore_state(state) {
    this.restoreCount += 1;
    this.restored.push(state.slice());
    this.state = state.slice();
  }

  run() {
    this.runCount += 1;
  }

  async destroy() {
    await Promise.resolve();
    this.destroyCount += 1;
  }
}

class NoStartV86 extends FakeV86 {
  emit(event, value) {
    if (event !== "emulator-started") super.emit(event, value);
  }
}

class SlowSaveV86 extends FakeV86 {
  async save_state() {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return super.save_state();
  }
}

class SlowRestoreV86 extends FakeV86 {
  async restore_state(state) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return super.restore_state(state);
  }
}

class SlowDestroyV86 extends FakeV86 {
  async destroy() {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return super.destroy();
  }
}

class HangingDestroyV86 extends FakeV86 {
  destroy() {
    return new Promise(() => {});
  }
}

class ThrowingV86 {
  constructor() {
    throw new Error("constructor failed");
  }
}

function createRuntime({
  onData = () => {},
  onStopped = () => {},
  V86Ctor = FakeV86,
  startTimeoutMs = 1000,
  destroyTimeoutMs = 1000
} = {}) {
  const instances = [];
  class TrackingV86 extends V86Ctor {
    constructor(options) {
      super(options);
      instances.push(this);
    }
  }
  const runtime = new V86Runtime({
    V86Ctor: TrackingV86,
    wasmPath: "/assets/vendor/v86/v86.wasm",
    biosPath: "/assets/vendor/v86/seabios.bin",
    vgaBiosPath: "/assets/vendor/v86/vgabios.bin",
    imagePath: "/assets/images/linux.iso",
    memorySize: 64 * 1024 * 1024,
    startTimeoutMs,
    destroyTimeoutMs,
    onData,
    onStopped
  });
  return { runtime, instances };
}

test("shell prompt detection accepts root prompts but not login or progress text", () => {
  assert.equal(hasShellPrompt("Welcome to Buildroot(none) login: "), false);
  assert.equal(hasShellPrompt("Progress 100% "), false);
  assert.equal(hasShellPrompt("root/root% "), true);
  assert.equal(hasShellPrompt("/root# "), true);
  assert.equal(hasShellPrompt("/% "), true);
  assert.equal(hasShellPrompt("output\n/home/learner# "), true);
});

test("start configures a serial-only Linux emulator and resolves when started", async () => {
  const { runtime, instances } = createRuntime();
  await runtime.start();
  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0].options, {
    wasm_path: "/assets/vendor/v86/v86.wasm",
    memory_size: 64 * 1024 * 1024,
    bios: { url: "/assets/vendor/v86/seabios.bin" },
    vga_bios: { url: "/assets/vendor/v86/vgabios.bin" },
    cdrom: { url: "/assets/images/linux.iso" },
    autostart: true,
    disable_keyboard: true
  });
});

test("concurrent start calls share one promise and one emulator", async () => {
  const { runtime, instances } = createRuntime();
  const first = runtime.start();
  const second = runtime.start();
  assert.equal(first, second);
  await first;
  assert.equal(instances.length, 1);
});

test("start timeout rejects and destroys the emulator", { timeout: 2000 }, async () => {
  const { runtime, instances } = createRuntime({ V86Ctor: NoStartV86, startTimeoutMs: 20 });
  await assert.rejects(runtime.start(), /timed out/);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].destroyCount, 1);
  assert.equal(runtime.emulator, null);
});

test("serial output reaches the consumer and UTF-8 input reaches the emulator as bytes", async () => {
  const received = [];
  const { runtime, instances } = createRuntime({ onData: (data) => received.push(data) });
  await runtime.start();
  instances[0].emit("serial0-output-byte", "h".charCodeAt(0));
  instances[0].emit("serial0-output-byte", "i".charCodeAt(0));
  runtime.write("中文🙂");
  assert.equal(received.join(""), "hi");
  assert.deepEqual(instances[0].sent, []);
  assert.deepEqual(instances[0].sentBytes, [
    { port: 0, bytes: Array.from(new TextEncoder().encode("中文🙂")) }
  ]);
});

test("baseline capture shares one in-flight promise", async () => {
  const { runtime, instances } = createRuntime({ V86Ctor: SlowSaveV86 });
  await runtime.start();
  const first = runtime.captureBaseline();
  const second = runtime.captureBaseline();
  assert.equal(first, second);
  await first;
  assert.equal(instances[0].saveCount, 1);
});

test("reset restores the captured baseline and shares one in-flight promise", async () => {
  const { runtime, instances } = createRuntime({ V86Ctor: SlowRestoreV86 });
  await runtime.start();
  await runtime.captureBaseline();
  instances[0].state = new Uint8Array([9, 9, 9]);
  const first = runtime.reset();
  const second = runtime.reset();
  assert.equal(first, second);
  await first;
  assert.deepEqual(Array.from(instances[0].restored[0]), [1, 2, 3]);
  assert.deepEqual(Array.from(instances[0].state), [1, 2, 3]);
  assert.equal(instances[0].runCount, 1);
});

test("snapshot and restore preserve explicit state", async () => {
  const { runtime, instances } = createRuntime();
  await runtime.start();
  instances[0].state = new Uint8Array([4, 5, 6]);
  const snapshot = await runtime.snapshot();
  instances[0].state = new Uint8Array([0]);
  await runtime.restore(snapshot);
  assert.deepEqual(Array.from(instances[0].state), [4, 5, 6]);
});

test("destroy awaits cleanup and ignores late serial output", async () => {
  const received = [];
  const { runtime, instances } = createRuntime({ V86Ctor: SlowDestroyV86, onData: (data) => received.push(data) });
  await runtime.start();
  const destroying = runtime.destroy();
  instances[0].emit("serial0-output-byte", "x".charCodeAt(0));
  await destroying;
  assert.equal(instances[0].destroyCount, 1);
  assert.equal(received.join(""), "");
  assert.throws(() => runtime.write("ls\n"), /not started/);
});

test("emulator stop is forwarded to the consumer", async () => {
  const stopped = [];
  const { runtime, instances } = createRuntime({ onStopped: () => stopped.push(true) });
  await runtime.start();
  instances[0].emit("emulator-stopped");
  assert.deepEqual(stopped, [true]);
});

test("synchronous constructor failure rejects the shared start promise", async () => {
  const { runtime, instances } = createRuntime({ V86Ctor: ThrowingV86 });
  const first = runtime.start();
  const second = runtime.start();
  assert.equal(first, second);
  await assert.rejects(first, /constructor failed/);
  assert.equal(instances.length, 0);
  assert.equal(runtime.startPromise, null);
});

test("destroy before start settles and does not poison later startup", async () => {
  const { runtime, instances } = createRuntime();
  await runtime.destroy();
  assert.equal(runtime.destroyPromise, null);
  await runtime.start();
  assert.equal(instances.length, 1);
  assert.equal(runtime.started, true);
});

test("destroy times out instead of hanging forever", { timeout: 1000 }, async () => {
  const { runtime } = createRuntime({ V86Ctor: HangingDestroyV86, destroyTimeoutMs: 20 });
  await runtime.start();
  const outcome = await Promise.race([
    runtime.destroy().then(() => "resolved", (error) => error.message),
    new Promise((resolve) => setTimeout(() => resolve("test-timeout"), 200))
  ]);
  assert.equal(outcome, "V86 destroy timed out");
  assert.equal(runtime.destroyPromise, null);
  assert.equal(runtime.emulator, null);
  await runtime.destroy();
});

test("a stop before startup cannot be undone by a late started event", async () => {
  const stopped = [];
  const { runtime, instances } = createRuntime({ onStopped: () => stopped.push(true) });
  const starting = runtime.start();
  instances[0].emit("emulator-stopped");
  await assert.rejects(starting, /stopped before startup/);
  instances[0].emit("emulator-started");
  assert.equal(runtime.started, false);
  assert.deepEqual(stopped, [true]);
  await assert.rejects(runtime.start(), /has stopped/);
  assert.equal(instances.length, 1);
});
