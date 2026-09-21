/**
 * layoutNotRestored.test.ts — #96：标签页布局只写不读，整条写侧下线
 *
 * 历史上 `useSpacePersistence` 每 3 秒把每个 Space 的标签页树序列化进
 * `tdsf-spaces.json` 的 `state:<spaceId>`，但唯一的读侧 `hydrateTabs()` 在
 * `d5c61a4`（2026-08-07 用户钦定"重启不用记住布局"）就把调用摘了 —— 写侧留
 * 下来变成"每 3 秒写一份没人读的数据"，还在 `beforeunload` 上挂了一次全量写。
 *
 * 用户 2026-09-21 拍板：「关闭了就都关闭了，肯定不用恢复，直接重启是干净页面」
 * → 写侧整体删除。本门禁钉住两件事：
 *  ① 布局持久化模块与写入口不许再被接回来（负向）；
 *  ② **工作区注册表本身仍然留存、启动仍回到欢迎页**（正向）—— 少了这条，
 *     判据会因为"整个 spaces 模块被删光"而假绿（#89 那轮的教训）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const SPACES = join(SRC, "modules/spaces");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("#96 标签页布局不再持久化", () => {
  it("序列化与持久化钩子两个模块已删除", () => {
    expect(existsSync(join(SPACES, "lib/serialize.ts"))).toBe(false);
    expect(existsSync(join(SPACES, "lib/useSpacePersistence.ts"))).toBe(false);
  });

  it("全仓没有任何文件再引用布局序列化/持久化入口", () => {
    // 锚在"模块路径以 /serialize 结尾"上，不能只看 serialize 这个词 ——
    // `@xterm/addon-serialize` 是 xterm 的缓冲快照插件，和布局持久化无关。
    const banned =
      /from\s+["'][^"']*\/serialize["']|from\s+["'][^"']*useSpacePersistence["']/;
    const hits = sourceFiles(SRC)
      .filter((f) => !/\.test\.(ts|tsx)$/.test(f))
      .filter((f) => banned.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f).replace(/\\/g, "/"));
    expect(hits).toEqual([]);
  });

  it("store 只留工作区清单的读写，不留标签页状态的写入口", () => {
    const store = read("modules/spaces/lib/store.ts");
    expect(store).not.toMatch(/\bfunction saveState\b/);
    expect(store).not.toMatch(/SpaceState/);
  });

  // 正向配对：删的是布局，不是工作区留存与"启动回欢迎页"这两条既有约定。
  it("工作区注册表仍落盘，启动仍固定回到欢迎页", () => {
    expect(read("modules/spaces/lib/store.ts")).toMatch(
      /store\.set\(KEY_SPACES/,
    );
    expect(read("modules/spaces/lib/useSpacesBoot.ts")).toMatch(
      /\.hydrate\(spaces,\s*null/,
    );
  });
});
