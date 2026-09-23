/**
 * retired-remote-tree.test.ts — #91② 的最终答案：远程文件树那一片是**死代码**，整片下线
 *
 * 清单原文写的是"`sshStore.currentPathBySession` 一个字段两个语义（终端 cwd / explorer 根），拆开"。
 * 查写入方后前提不成立：explorer 那一半**没有活着的写入方** ——
 *   · `navigateTo` 的唯一 UI 入口是 `SshFileTree`，而它在生产里从未被挂载
 *     （活着的远程树是 `FileExplorer` + `fsb_*` / `workspaceFsStore`，
 *      `src/modules/explorer/**` 对 sshStore 零引用）；
 *   · 编辑器/传输任务那两组（`openFile`/`saveFile`/`transferTasks`）同样只有 store 自己在动；
 *   · `SshTerminalHost` 早在 #21 分屏重构时被 `PaneTreeView.SshLeafPane` 取代，只剩注释在引用它。
 * ⇒ 这个字段今天只有一个语义（远端 shell 的 cwd），"拆开"是在给死代码续命。
 * 用户 2026-09-22 拍板：「行，你删就删吧」→ 整片删除。
 *
 * 本门禁钉两件事，缺一条就会假绿（#96/#89 那两条教训）：
 *  ① 负向：退役组件不许回来、sshStore 不许再留半套动作（半删=调用点直接崩）；
 *  ② 正向：**连接管理面板 / 主机审批 / 会话级 cwd / carapace 检测都还在**，
 *     证明删掉的是"没人读的远程文件树"，不是整个 SSH 模块。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const MODULE = join(process.cwd(), "src/modules/ssh-explorer");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const read = (name: string) => readFileSync(join(MODULE, name), "utf8");

/**
 * 判据只看代码，不看散文 —— 退役记录本身要留在注释里（否则下一手又会去
 * "恢复那个看起来像漏删的东西"），所以扫之前先剥注释。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // 行尾注释也要剥（`return 5; // 旧组件名` 这种最会留在代码行后面）；
    // 用 [^:] 守卫免得把 `https://` 里的双斜杠当注释切掉。
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = (name: string) => stripComments(read(name));

describe("#91② 退役的远程文件树不许回来", () => {
  it("四个退役组件文件已删除", () => {
    for (const gone of [
      "SshFileTree.tsx",
      "SshFileTransfer.tsx",
      "SshFileEditor.tsx",
      "SshTerminalHost.tsx",
    ]) {
      expect(existsSync(join(MODULE, gone)), gone).toBe(false);
    }
  });

  it("sshStore 里不再留任何一棵树的动作与缓存（半删=调用点直接崩）", () => {
    const store = code("sshStore.ts");
    const banned = [
      "listDir",
      "navigateTo",
      "loadChildren",
      "toggleExpand",
      "refreshCurrent",
      "createDir",
      "renamePath",
      "deletePath",
      "selectPath",
      "openFile",
      "saveFile",
      "closeEditor",
      "updateEditorContent",
      "removeTransferTask",
      "entriesBySession",
      "childrenByPathBySession",
      "expandedPathsBySession",
      "loadingBySession",
      "loadingChildrenByPathBySession",
      "selectedPath",
      "editingFile",
      "transferTasks",
    ];
    for (const name of banned) {
      expect(store, `sshStore 不应再有 ${name}`).not.toContain(name);
    }
  });

  it("模块内没有文件再引用这些退役组件", () => {
    const banned = /SshFileTree|SshFileTransfer|SshTerminalHost/;
    const hits = sourceFiles(MODULE)
      .filter((f) => banned.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(MODULE, f));
    expect(hits).toEqual([]);
  });
});

describe("配对：删的是文件树，不是整个 SSH 模块", () => {
  it("主机审批对话框的宿主文件仍在（审批队列的挂载点）", () => {
    // 2026-09-23：组件从 SshExplorer.tsx 搬进自己的文件 —— 那片面板的去留还挂在
    // #109 上等用户拍，审批框是活的，不该寄生在可能被整片删掉的文件里。
    expect(existsSync(join(MODULE, "HostApprovalDialog.tsx"))).toBe(true);
    expect(code("HostApprovalDialog.tsx")).toContain(
      "export function HostApprovalDialog",
    );
  });

  it("会话级远端 cwd 仍由 sshStore 唯一持有，连接成功后仍种家目录", () => {
    const store = code("sshStore.ts");
    expect(store).toContain("currentPathBySession");
    expect(store).toContain("setCurrentPath:");
    expect(store).toMatch(/setCurrentPath\(sessionId, initial\)/);
  });

  it("carapace 检测与终端数据订阅仍在（SSH 终端链路的活件）", () => {
    const store = code("sshStore.ts");
    expect(store).toContain("remoteCarapaceBySession");
    expect(store).toContain("subscribeTerminalData");
    expect(existsSync(join(MODULE, "SshCarapaceBadge.tsx"))).toBe(true);
  });

  it("模块入口仍导出 store 与两个活性判据", () => {
    const index = code("index.ts");
    for (const kept of [
      "useSshStore",
      "isSessionConnected",
      "isSessionConnecting",
      "selectSessionCurrentPath",
    ]) {
      expect(index, `index.ts 不应丢掉 ${kept}`).toContain(kept);
    }
  });
});
