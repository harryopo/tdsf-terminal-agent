export function hasShellPrompt(text) {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return /(?:^|[\r\n])(?:\/(?:[\w./-]+)?|[A-Za-z0-9_.-]+\/[\w./-]+)[%#] $/.test(clean);
}

export class V86Runtime {
  constructor({
    V86Ctor,
    wasmPath,
    biosPath,
    vgaBiosPath,
    imagePath,
    memorySize = 64 * 1024 * 1024,
    startTimeoutMs = 20000,
    destroyTimeoutMs = 5000,
    onData = () => {},
    onStopped = () => {}
  }) {
    this.V86Ctor = V86Ctor;
    this.wasmPath = wasmPath;
    this.biosPath = biosPath;
    this.vgaBiosPath = vgaBiosPath;
    this.imagePath = imagePath;
    this.memorySize = memorySize;
    this.startTimeoutMs = startTimeoutMs;
    this.destroyTimeoutMs = destroyTimeoutMs;
    this.onData = onData;
    this.onStopped = onStopped;
    this.emulator = null;
    this.baseline = null;
    this.started = false;
    this.stopped = false;
    this.destroying = false;
    this.generation = 0;
    this.startPromise = null;
    this.baselinePromise = null;
    this.resetPromise = null;
    this.destroyPromise = null;
    this.decoder = new TextDecoder("utf-8");
    this.encoder = new TextEncoder();
  }

  start() {
    if (this.destroyPromise) return Promise.reject(new Error("V86 runtime is destroying"));
    if (this.startPromise) return this.startPromise;
    if (this.emulator && this.started) return Promise.resolve();
    if (this.emulator && this.stopped) return Promise.reject(new Error("V86 emulator has stopped"));
    const generation = ++this.generation;
    this.started = false;
    this.stopped = false;
    this.destroying = false;
    let emulator;
    try {
      emulator = new this.V86Ctor({
        wasm_path: this.wasmPath,
        memory_size: this.memorySize,
        bios: { url: this.biosPath },
        vga_bios: { url: this.vgaBiosPath },
        cdrom: { url: this.imagePath },
        autostart: true,
        disable_keyboard: true
      });
    } catch (error) {
      const promise = Promise.reject(error);
      this.startPromise = promise;
      const cleanup = () => {
        if (this.startPromise === promise) this.startPromise = null;
      };
      promise.then(cleanup, cleanup);
      return promise;
    }
    this.emulator = emulator;
    emulator.add_listener("serial0-output-byte", (byte) => {
      if (this.destroying || generation !== this.generation) return;
      const text = this.decoder.decode(Uint8Array.of(byte), { stream: true });
      if (text) this.onData(text);
    });
    const promise = new Promise((resolve, reject) => {
      let settled = false;
      let timeout;
      emulator.add_listener("emulator-stopped", () => {
        if (this.destroying || generation !== this.generation) return;
        this.started = false;
        this.stopped = true;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("V86 emulator stopped before startup"));
        }
        this.onStopped();
      });
      timeout = setTimeout(async () => {
        if (settled) return;
        settled = true;
        const error = new Error("V86 start timed out");
        try {
          await this.destroy();
        } catch {
          // Preserve the startup failure even when emulator cleanup also times out.
        }
        reject(error);
      }, this.startTimeoutMs);
      emulator.add_listener("emulator-started", () => {
        if (settled || this.destroying || generation !== this.generation || this.stopped) return;
        settled = true;
        clearTimeout(timeout);
        this.started = true;
        resolve();
      });
    });
    this.startPromise = promise;
    const cleanup = () => {
      if (this.startPromise === promise) this.startPromise = null;
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  write(data) {
    if (!this.emulator || !this.started || this.destroying) {
      throw new Error("V86 runtime is not started");
    }
    this.emulator.serial_send_bytes(0, this.encoder.encode(data));
  }

  captureBaseline() {
    if (!this.emulator || !this.started) throw new Error("V86 runtime is not started");
    if (this.baseline) return Promise.resolve(this.baseline);
    if (this.baselinePromise) return this.baselinePromise;
    const generation = this.generation;
    const promise = this.emulator.save_state().then((state) => {
      if (generation !== this.generation || this.destroying) {
        throw new Error("V86 baseline capture was cancelled");
      }
      this.baseline = state;
      return state;
    });
    this.baselinePromise = promise;
    const cleanup = () => {
      if (this.baselinePromise === promise) this.baselinePromise = null;
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  reset() {
    if (!this.emulator || !this.started) throw new Error("V86 runtime is not started");
    if (!this.baseline) throw new Error("V86 baseline has not been captured");
    if (this.resetPromise) return this.resetPromise;
    const generation = this.generation;
    const promise = this.emulator.restore_state(this.baseline).then(() => {
      if (generation !== this.generation || this.destroying) {
        throw new Error("V86 reset was cancelled");
      }
      this.decoder = new TextDecoder("utf-8");
      this.emulator.run();
    });
    this.resetPromise = promise;
    const cleanup = () => {
      if (this.resetPromise === promise) this.resetPromise = null;
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  async snapshot() {
    if (!this.emulator || !this.started) throw new Error("V86 runtime is not started");
    return this.emulator.save_state();
  }

  async restore(state) {
    if (!this.emulator || !this.started) throw new Error("V86 runtime is not started");
    await this.emulator.restore_state(state);
    this.decoder = new TextDecoder("utf-8");
    this.emulator.run();
  }

  destroy() {
    if (this.destroyPromise) return this.destroyPromise;
    const emulator = this.emulator;
    const generation = ++this.generation;
    this.destroying = true;
    this.started = false;
    this.stopped = true;
    let promise = Promise.resolve();
    if (emulator) {
      promise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("V86 destroy timed out")), this.destroyTimeoutMs);
        Promise.resolve().then(() => emulator.destroy()).then(
          () => {
            clearTimeout(timeout);
            resolve();
          },
          (error) => {
            clearTimeout(timeout);
            reject(error);
          }
        );
      });
    }
    this.destroyPromise = promise;
    const cleanup = () => {
      if (this.destroyPromise !== promise || generation !== this.generation) return;
      this.emulator = null;
      this.baseline = null;
      this.decoder = new TextDecoder("utf-8");
      this.destroying = false;
      this.destroyPromise = null;
    };
    promise.then(cleanup, cleanup);
    return promise;
  }
}
