/**
 * src/lib/tauri-command-registry.test.ts —— 前端 invoke 的命令必须真的注册了
 *
 * 起因（2026-09-19，#67 真机探针当场撞出来）：`sidecar-bridge.getStatus()` 调
 * `invoke('ipc_status')`，而 `ipc.rs` 里这个命令**写好了却没进 lib.rs 的
 * `generate_handler!`** —— 运行时固定报 "Command ipc_status not found"。
 * 它躲过了全部单测：桥接层没有真 Tauri 可调，`BackendPill` 当年还因为"isRunning()
 * 不好用"改道去调 `sidecar.health`（`BackendPill.tsx:151-154` 的注释就是这件事的化石），
 * 于是这个洞一直躺在那儿等下一个人踩。
 *
 * 这条测试把整类问题关掉：扫前端所有 `invoke('<命令名>')` 字面量，逐个对照
 * lib.rs 注册表。Rust 侧改名/漏注册，这里当场红。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 路径解析沿用 `src/app/tauri-dev-isolation.test.ts` 已在用的写法（同一仓库内已验证可行）
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LIB_RS = resolve(REPO_ROOT, "src-tauri/src/lib.rs");

// 与 `src/modules/translate/enrich.test.ts` 的红线扫描同一手法：直接拿源码文本扫，
// 不 import 被测模块（import 会把 Tauri 依赖拖进测试运行时）。
const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 取 `generate_handler![ ... ]` 括号内的注册清单（手工配对，防嵌套）。 */
function registeredCommands(source: string): Set<string> {
  const marker = "generate_handler![";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("lib.rs 里找不到 generate_handler!，测试要先跟着改");
  let depth = 0;
  let end = -1;
  for (let i = start + marker.length - 1; i < source.length; i++) {
    if (source[i] === "[") depth += 1;
    else if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error("generate_handler! 括号没闭合");
  const body = source.slice(start + marker.length, end);
  const names = new Set<string>();
  for (const line of body.split("\n")) {
    const entry = line.replace(/\/\/.*$/, "").trim().replace(/,$/, "");
    if (!entry || entry.startsWith("#")) continue;
    const last = entry.split("::").pop()?.trim();
    if (last && /^[a-z_][a-z0-9_]*$/i.test(last)) names.add(last);
  }
  return names;
}

/** 前端所有 `invoke('cmd')` / `invoke<T>("cmd")` 字面量（插件命令带冒号，跳过）。 */
function frontendInvokedCommands(): Map<string, string[]> {
  const calls = new Map<string, string[]>();
  const pattern = /\binvoke(?:<[^<>()]*>)?\s*\(\s*['"]([a-zA-Z0-9_|:-]+)['"]/g;
  for (const [rel, text] of Object.entries(SOURCES)) {
    if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
    for (const m of text.matchAll(pattern)) {
      const name = m[1];
      if (name.includes(":") || name.includes("|")) continue; // 插件命令不归 generate_handler 管
      calls.set(name, [...(calls.get(name) ?? []), rel]);
    }
  }
  return calls;
}

/**
 * 已知的"前端在调、Rust 没注册"历史欠账 —— 逐个核过：调用方全部是**没有生产入口的
 * 死包装**（`grep` 过 import：没有任何模块引用这两个文件的这些函数），
 * 所以今天不会炸在用户面前。列在这里而不是放宽测试，理由有两条：
 *  1. 新增未注册命令必须当场红（异常清单只减不增）；
 *  2. 这批死包装属于 #71 同一族（半退役通道 / 模板残留），下线时要连着这张清单一并删。
 * 见 ROADMAP #81。
 */
const KNOWN_DEAD_CALLS: Record<string, string> = {
  sandbox_create: "src/lib/sandbox-bridge.ts 整体无调用方（Rust 侧 sandbox 模块实现存在但未注册）",
  sandbox_status: "同上",
  sandbox_start: "同上",
  sandbox_stop: "同上",
  sandbox_remove: "同上",
  sandbox_exec: "同上",
  sandbox_list: "同上",
  ping: "src/lib/tauri.ts 的 Tauri 模板残留（commands.rs::ping 未注册）",
  get_version: "同上",
  get_build_info: "同上",
  pty_spawn: "src/lib/tauri.ts 旧包装；现网走 pty_open / pty_write（Rust 无 pty_spawn）",
  pty_kill: "同上（Rust 侧叫 pty_close）",
  pty_list: "同上（Rust 侧叫 pty_list_shells）",
};

describe("前端 invoke 的 Tauri 命令注册表一致性", () => {
  const registered = registeredCommands(readFileSync(LIB_RS, "utf8"));

  it("注册表解析出来了（解析式子失效会让本文件假绿）", () => {
    expect(registered.size).toBeGreaterThan(80);
    expect(registered.has("ipc_invoke")).toBe(true);
    expect(registered.has("ipc_status")).toBe(true); // 2026-09-19 补：此前实现存在却没注册
  });

  it("扫到的调用面足够大（扫描式子没退化）", () => {
    const calls = frontendInvokedCommands();
    expect(calls.size).toBeGreaterThan(40);
    for (const must of ["ipc_invoke", "ssh_command", "pty_write"]) {
      expect(calls.has(must), `没扫到 ${must}，扫描式子可能已失效`).toBe(true);
    }
  });

  it("每个前端 invoke 的命令都在 lib.rs 注册了（除已登记的死包装欠账）", () => {
    const missing: string[] = [];
    for (const [name, files] of frontendInvokedCommands()) {
      if (registered.has(name)) continue;
      if (name in KNOWN_DEAD_CALLS) continue;
      missing.push(`${name} ← ${[...new Set(files)].join(", ")}`);
    }
    expect(
      missing,
      "这些命令前端在调、Rust 没注册，运行时必报 Command not found：\n" + missing.join("\n"),
    ).toEqual([]);
  });

  it("欠账清单只减不增（修掉一个就把它从 KNOWN_DEAD_CALLS 删掉）", () => {
    const stillUnregistered = Object.keys(KNOWN_DEAD_CALLS).filter(
      (name) => !registered.has(name),
    );
    const fixed = Object.keys(KNOWN_DEAD_CALLS).filter((name) => registered.has(name));
    expect(
      fixed,
      `这些命令已经注册了，请把它们从 KNOWN_DEAD_CALLS 里删掉：${fixed.join(", ")}`,
    ).toEqual([]);
    expect(stillUnregistered.length).toBe(Object.keys(KNOWN_DEAD_CALLS).length);
  });
});
