/**
 * retired-ssh-panel.test.ts — #109 的答案：那片不可达的 SSH 连接面板整片下线
 *
 * 用户 2026-09-25 拍板「检查用途，有用就继续开发」。查完的结论是**没有替代不了的用途**：
 *   · 侧栏视图枚举 2026-08-01 就把 `"ssh"` 摘了（`sidebar/types.ts` 顶部注释写明
 *     "SSH 登录统一走新建工作区流程"），此后 `SshExplorer.tsx` 与它挂的
 *     `SshConnectDialog.tsx` **没有任何挂载点** —— 全仓除 `index.ts` 再导出外无人 import；
 *   · 面板独占的三条"独有能力"在 #89（一个标签页一条连接）模型下都已过时：
 *     "手动切活动会话" = 切标签页、"逐条断开" = 关标签页（`orphanedSshSessions` 会释放它
 *     独占的会话）、"不建工作区只开连接" 这条差异被 `App.tsx` 的自动建 Space 吞掉；
 *   · 连接本身的表单/测试连接/已保存列表/删除/按需取密码，「新建工作区 → SSH」
 *     （`SpaceCreateDialog`）全都覆盖，而且是 #122/#124 重做后的版本。
 *
 * 所以按他给的另一条分支执行：**连同死代码一起删**。本门禁钉三件事：
 *  ① 退役的三个文件不许回来、`sshStore` 不许留半套弹窗动作（半删 = 调用点直接崩）；
 *  ② 侧栏枚举不许再加回 `"ssh"`（否则下一手又会接出一个和 SpaceSwitcher 打架的重复面）；
 *  ③ 正向配对（**缺这条就是假绿** —— 删干净了当然"没人引用"）：
 *     主机审批框仍挂载、连接中遮罩仍拿得到状态文案、store 的活性判据还在导出。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const MODULE = join(process.cwd(), "src/modules/ssh-explorer");
const SRC = join(process.cwd(), "src");

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allSourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** 判据只看代码不看散文（退役说明本身要留在注释里，见 retired-remote-tree 同一手法） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = (abs: string) => stripComments(readFileSync(abs, "utf8"));
const moduleCode = (name: string) => code(join(MODULE, name));

describe("#109 退役的 SSH 连接面板不许回来", () => {
  it("三个只服务于那片面板的文件已删除", () => {
    for (const gone of [
      "SshExplorer.tsx",
      "SshConnectDialog.tsx",
      "SshStatusDot.tsx",
    ]) {
      expect(existsSync(join(MODULE, gone)), gone).toBe(false);
    }
  });

  it("全仓没有任何生产代码再引用它们（活的 SshExplorerOffline 不算，那是另一个组件）", () => {
    const banned = /\bSshExplorer\b|\bSshConnectDialog\b|\bSshStatusDot\b/;
    const hits = allSourceFiles(SRC)
      .filter((f) => banned.test(code(f)))
      .map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });

  it("sshStore 里不再留弹窗那三个字段（半删=调用点直接崩）", () => {
    const store = moduleCode("sshStore.ts");
    for (const name of [
      "connectDialogOpen",
      "openConnectDialog",
      "closeConnectDialog",
    ]) {
      expect(store, `sshStore 不应再有 ${name}`).not.toContain(name);
    }
  });

  it("侧栏视图枚举不加回 \"ssh\"（要连接总览请按 #89 的标签页模型另做）", () => {
    const types = code(join(process.cwd(), "src/modules/sidebar/types.ts"));
    expect(types).not.toMatch(/^\s*\|\s*"ssh"\s*$/m);
  });

  it("模块入口不再导出这三个符号", () => {
    const index = moduleCode("index.ts");
    for (const gone of ["SshExplorer", "SshConnectDialog", "SshStatusDot"]) {
      expect(index, `index.ts 不应再导出 ${gone}`).not.toContain(
        `from './${gone}'`,
      );
    }
  });
});

/**
 * 正向配对：删的是那一片面板，不是整个 SSH 模块。
 * 没有这一组，上面五条会因为"整个模块都被删了"而全部通过。
 */
describe("配对：连接链路的活件一件没少", () => {
  it("主机审批框还在，并且仍被 App.tsx 顶层挂载", () => {
    expect(existsSync(join(MODULE, "HostApprovalDialog.tsx"))).toBe(true);
    expect(moduleCode("HostApprovalDialog.tsx")).toContain(
      "export function HostApprovalDialog",
    );
    expect(code(join(SRC, "app/App.tsx"))).toContain("<HostApprovalDialog");
  });

  it("连接中遮罩还在，并且仍拿得到 9 态状态文案（stateLabel 换了主人没换语义）", () => {
    const overlay = moduleCode("SshConnectingOverlay.tsx");
    expect(overlay).toContain("stateLabel");
    expect(existsSync(join(MODULE, "lib/sshStateLabel.ts"))).toBe(true);
    const label = moduleCode(join("lib", "sshStateLabel.ts"));
    for (const zh of [
      "空闲",
      "连接中",
      "握手",
      "验证主机",
      "认证中",
      "已认证",
      "已连接",
      "重连中",
      "失败",
      "已关闭",
    ]) {
      expect(label, `sshStateLabel 丢了 ${zh}`).toContain(zh);
    }
  });

  it("store 的连接判据与导出还在（App / chatStore / SpaceSwitcher 都在吃它们）", () => {
    const index = moduleCode("index.ts");
    for (const kept of [
      "useSshStore",
      "isSessionConnected",
      "isSessionConnecting",
      "selectActiveSession",
    ]) {
      expect(index, `index.ts 不应丢掉 ${kept}`).toContain(kept);
    }
    const store = moduleCode("sshStore.ts");
    for (const kept of ["connectWithSaved", "deleteSavedConnection", "disconnect"]) {
      expect(store, `sshStore 丢了活动作 ${kept}`).toContain(kept);
    }
  });
});
