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
 * 已知的"前端在调、Rust 没注册"欠账 —— **#81 已清空（2026-09-20，用户决策 6：同意删）**。
 * 原先挂着 13 条：`sandbox_*`（`src/lib/sandbox-bridge.ts` 整文件无调用方）、
 * `ping/get_version/get_build_info`、`pty_spawn/pty_kill/pty_list`（`src/lib/tauri.ts` 的
 * Tauri 模板残留 + 旧命令名）。处置是**整文件删**而不是逐个补注册 —— 给死代码注册命令
 * 等于把它永久焊住。那两个文件里唯一还在用的是 `isTauri()`，它与 `@/lib/tauriRuntime`
 * 的 `isTauriRuntime()` 是同一句判定，已合并到后者（顺带少一个重复概念）。
 *
 * 空表是本文件的硬要求：新增条目必须带 ROADMAP 编号并写清"为什么现在不能注册"，
 * 否则就地补注册或删调用方。
 * Rust 侧那笔没动：`src-tauri/src/modules/sandbox/`（1921 行、外部零引用、命令从未进
 * `generate_handler!`）与 `commands.rs` 的 ping/get_version/get_build_info ——
 * 那是"要不要做 T-P2-08 Docker 沙箱"的产品决定，见 ROADMAP #86。
 */
const KNOWN_DEAD_CALLS: Record<string, string> = {};

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

  it("欠账清单只减不增（#81 起必须保持为空）", () => {
    expect(
      Object.keys(KNOWN_DEAD_CALLS),
      "死包装清单已在 #81 清空；再加条目要带 ROADMAP 编号并说明为什么不能就地补注册",
    ).toEqual([]);
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
