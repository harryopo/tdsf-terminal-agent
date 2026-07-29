// TDSF 魔改 (P5 浏览器降级): Tauri runtime mock stub for dev 模式
// -----------------------------------------------------------------------------
// 在 pnpm dev (纯 Vite 浏览器) 模式下, 没有真实的 Tauri 运行时, 所有
// `@tauri-apps/api` 的 invoke / listen / getCurrentWindow 等调用都会因为
// `window.__TAURI_INTERNALS__` 不存在而抛 TypeError, 整个 app 渲染不出。
//
// 解决: 在 main.tsx 顶部、其它任何模块加载之前, 注入一个完整的 stub
// __TAURI_INTERNALS__ 对象, 让所有 Tauri 调用降级为 noop 并返回合理默认值。
//   - invoke()           → 返回 null / 空数组 / 空对象, 不抛错
//   - transformCallback  → 返回递增 id
//   - metadata           → 返回空对象 (修复 metadata undefined 错误)
//   - callbacks          → 内部 Map 存 callback (transformCallback 用)
//   - unregisterCallback → 清理 callback
//
// 必须在任何 import "@tauri-apps/api/..." 模块之前执行, 否则 Tauri 内部
// 缓存的 metadata 会带 undefined, 后续调用仍然失败。
//
// 注意: 这只对 pnpm dev 模式有效 (import.meta.env.DEV + 无 __TAURI_INTERNALS__)。
// 生产模式 (Tauri 桌面运行时) 不会注入 stub, 走真实 Tauri 路径。

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: <T>(cmd: string, args?: unknown, options?: unknown) => Promise<T>;
      transformCallback: (callback?: unknown, once?: boolean) => number;
      metadata: Record<string, unknown>;
      callbacks: Map<number, { callback: unknown; once: boolean }>;
      unregisterCallback: (id: number) => void;
      [key: string]: unknown;
    };
    // TDSF 魔改 2026-07-28: Tauri 2.x event plugin 新增的 internals 接口,
    // _unlisten 内部调用 __TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener,
    // mock 模式下未注入会抛 "Cannot read properties of undefined (reading 'unregisterListener')".
    // 修饰符必须与 Tauri 自身 event.d.ts 保持一致 (required, 不带 ?), 否则 TS2687 冲突.
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener: (event: string, eventId: number) => void;
    };
  }
}

const isDevBrowser =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window);

if (isDevBrowser) {
  if (typeof console !== "undefined") {
    console.info(
      "[TauriMock] dev browser mode detected, injecting __TAURI_INTERNALS__ stub",
    );
  }

  const callbacks = new Map<
    number,
    { callback: (...args: unknown[]) => void; once: boolean }
  >();
  let nextCallbackId = 1;

  /**
   * 智能 invoke stub: 不同命令返回不同合理默认值, 让上游 store / hook 拿到
   * 期望的数据结构而不是 null, 避免上游代码 NPE.
   */
  const invoke = <T = unknown>(
    cmd: string,
    _args?: unknown,
    _options?: unknown,
  ): Promise<T> => {
    if (typeof console !== "undefined") {
      console.debug(`[TauriMock] invoke('${cmd}') → noop`);
    }

    // LazyStore / Store plugin: 返回 entries / get / set / save / delete / has / clear / reset
    if (
      cmd.startsWith("plugin:store|") ||
      cmd === "store_load" ||
      cmd === "store_get" ||
      cmd === "store_set" ||
      cmd === "store_save" ||
      cmd === "store_entries" ||
      cmd === "store_delete" ||
      cmd === "store_has" ||
      cmd === "store_clear" ||
      cmd === "store_reset" ||
      cmd === "store_keys" ||
      cmd === "store_values" ||
      cmd === "store_length"
    ) {
      // entries 期望 [[k,v], [k,v]] 二维数组; get 期望 [v, exists] 二元组
      if (cmd.endsWith("entries") || cmd.endsWith("get_store_entries")) {
        return Promise.resolve([] as unknown as T);
      }
      // TDSF 魔改 2026-07-28: plugin:store|get 必须返回 [value, exists] 二元组,
      // 上游解构 const [value, exists] = await invoke(...). 返回 undefined 会抛
      // "(intermediate value) is not iterable". 修复: 返回 [undefined, false].
      if (
        cmd === "plugin:store|get" ||
        cmd.endsWith("|get") ||
        cmd === "store_get"
      ) {
        return Promise.resolve([undefined, false] as unknown as T);
      }
      if (cmd.endsWith("has") || cmd.endsWith("has_store")) {
        return Promise.resolve(false as unknown as T);
      }
      if (cmd.endsWith("length")) {
        return Promise.resolve(0 as unknown as T);
      }
      if (cmd.endsWith("keys") || cmd.endsWith("values")) {
        return Promise.resolve([] as unknown as T);
      }
      // set / save / delete / clear / reset / create → undefined
      return Promise.resolve(undefined as unknown as T);
    }

    // fs_* / shell_* / pty_* / ssh_* / sidecar_* / agent_* / skill_* 等
    // 大部分命令都是返回 undefined (setter / action), 个别查询返回 []
    if (cmd.startsWith("plugin:fs|"))
      return Promise.resolve([] as unknown as T);
    if (cmd.startsWith("plugin:shell|"))
      return Promise.resolve(undefined as unknown as T);
    if (cmd.startsWith("plugin:pty|"))
      return Promise.resolve(undefined as unknown as T);
    // TDSF 魔改 2026-07-28: plugin:event|listen 期望返回 [eventId, unregisterFn] 二元组.
    // mock 返回 undefined 会抛 "unregisterListener of undefined" 错误.
    // 修复: 返回 [0, () => {}] - Tauri 内部用 unregisterListener(eventId).
    if (cmd.startsWith("plugin:event|")) {
      if (cmd === "plugin:event|listen" || cmd === "plugin:event|once") {
        return Promise.resolve([0, () => {}] as unknown as T);
      }
      return Promise.resolve(undefined as unknown as T);
    }
    if (cmd.startsWith("plugin:process|"))
      return Promise.resolve(undefined as unknown as T);
    if (cmd.startsWith("plugin:updater|"))
      return Promise.resolve(undefined as unknown as T);
    if (cmd.startsWith("plugin:window|"))
      return Promise.resolve(undefined as unknown as T);
    if (cmd.startsWith("plugin:webview|"))
      return Promise.resolve(undefined as unknown as T);
    if (cmd.startsWith("plugin:app|"))
      return Promise.resolve(undefined as unknown as T);
    if (cmd.startsWith("plugin:path|"))
      return Promise.resolve("" as unknown as T);
    if (cmd.startsWith("plugin:os|"))
      return Promise.resolve(undefined as unknown as T);

    // === TDSF 魔改 2026-07-28: launchDir 相关命令返回空, 防止 .map 抛错 ===
    if (cmd === "get_launch_dir" || cmd === "workspace_current_dir") {
      return Promise.resolve(null as unknown as T);
    }
    if (cmd === "get_launch_files") {
      return Promise.resolve([] as unknown as T);
    }

    // === TDSF 魔改 2026-07-28: SSH 业务命令 mock 返回, 避免 dev 模式下崩 ===
    // ssh_test: 模拟 "测试失败", 让用户知道需要 Tauri 桌面运行时才能真连
    if (cmd === "ssh_test") {
      return Promise.resolve({
        ok: false,
        message:
          "SSH 功能需要 Tauri 桌面运行时 (pnpm tauri dev), 浏览器 dev 模式仅用于 UI 预览",
      } as unknown as T);
    }
    // ssh_credentials_list: 返回空数组, 防止下层 .map 抛错
    if (cmd === "ssh_credentials_list") {
      return Promise.resolve([] as unknown as T);
    }
    // ssh_connect: 立即抛错 (不挂 15s 超时), 提示用户切到 Tauri 桌面运行时
    if (cmd === "ssh_connect") {
      return Promise.reject(
        new Error(
          "SSH 连接需要 Tauri 桌面运行时 (pnpm tauri dev), 浏览器 dev 模式仅用于 UI 预览",
        ),
      ) as Promise<T>;
    }

    // 默认: 业务 invoke 命令 (fs_*, pty_*, ssh_*, sidecar_*, agent_*, skill_*, risk_*, ...).
    // 业务侧普遍带 .catch(()=>{}) / ?.(), 拿到 undefined 不会崩。
    return Promise.resolve(undefined as unknown as T);
  };

  const transformCallback = (
    callback?: (...args: unknown[]) => void,
    once = false,
  ): number => {
    if (!callback) return -1;
    const id = nextCallbackId++;
    callbacks.set(id, { callback, once });
    return id;
  };

  const unregisterCallback = (id: number): void => {
    callbacks.delete(id);
  };

  // 元数据 stub: 上游 getCurrent() / metadata 相关读 metadata.currentWindow / metadata.windows
  // 真实 Tauri 提供 { currentWindow: { label, name }, currentWebview: {...}, windows: [...] }
  // 这里给个最小可用形态, 避免上游 .metadata.currentWindow.label 抛错
  const metadata = {
    currentWindow: { label: "main", name: "main" },
    currentWebview: { label: "main", name: "main" },
    windows: [{ label: "main", name: "main" }],
    webviews: [{ label: "main", name: "main" }],
  };

  // biome-ignore lint/suspicious/noExplicitAny: Tauri internals are untyped global hooks; casting to any mirrors runtime behavior for the mock.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    metadata,
    callbacks,
    unregisterCallback,
    // 其它可能的内部 hook (某些 plugin 会查)
    unregisterListener: unregisterCallback,
  };

  // TDSF 魔改 2026-07-28: Tauri 2.x event plugin 的 internals 接口
  // _unlisten(event, eventId) 内部调用此接口清理 callback,
  // mock 模式下未注入会抛 "Cannot read properties of undefined (reading 'unregisterListener')"
  // biome-ignore lint/suspicious/noExplicitAny: Tauri event plugin internals are untyped; any is required to attach the mock.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event: string, _eventId: number) => {
      // mock 模式: callback 已通过 unregisterCallback 清理, 这里 noop 即可
    },
  };
}

export {};
