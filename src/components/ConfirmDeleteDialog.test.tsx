/**
 * ConfirmDeleteDialog.test.tsx —— #166 ③（2026-09-28 用户实测）
 * -----------------------------------------------------------------------------
 * 用户原话：「删除的时候应该弹出一个确认删除的窗口，当前做的太丑了，再优化一下，
 * 变为那种大气顶级设计……再加点动效」。
 *
 * 界面好不好看要靠真机看图，这里钉的是**功能与取向**四条：
 * ① 说的必须是"正在删的那一条"（名字 + 事实行），不是笼统一句"确定吗"；
 * ② 第一下点删除图标只开窗，**不许**直接删（这条是负向，配 ③ 一起才有效）；
 * ③ 确认才真删（正向配对：缺了它，"没调用"会因为"根本点不到"而假绿 —— #166 那轮
 *    记过三次的老账）；
 * ④ 删除在飞的时候不许关窗、不许重复提交。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ConfirmDeleteDialog,
  type DeleteConfirmation,
} from "./ConfirmDeleteDialog";

/** 读源码用绝对路径：happy-dom 下 `import.meta.url` 不是 file: 协议（本仓惯例） */
const src = (rel: string) =>
  readFileSync(join(process.cwd(), "src", rel), "utf8");

/**
 * 注释里可以解释"旧写法为什么没了"，但那句话不该被横扫当成活缺陷 —— #159 的漂移闸
 * 踩过同一个坑（文本级判断分不清代码与注释）。这里只扫代码：整行 `//` 与块注释剥掉。
 * 不做词法级还原（为一个判据引一个 parser 不划算），所以别把判据词写进字符串字面量。
 */
const codeOnly = (text: string) =>
  text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const request: DeleteConfirmation = {
  subject: "这台已保存的服务器",
  name: "lab",
  impact: "本机保存的登录信息会一起删除。已建好的工作区不受影响。",
  facts: [
    { label: "地址", value: "192.168.45.128:22" },
    { label: "用户名", value: "root" },
  ],
};

function renderDialog(
  props: Partial<Parameters<typeof ConfirmDeleteDialog>[0]> = {},
) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmDeleteDialog
      request={request}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onOpenChange, onConfirm };
}

afterEach(cleanup);

describe("ConfirmDeleteDialog — 说清要消失的是哪一条", () => {
  it("开窗就把类型、名字、影响范围和每一条事实都摆出来", () => {
    renderDialog();
    const dialog = screen.getByTestId("confirm-delete-dialog");
    expect(dialog.textContent).toContain("删除这台已保存的服务器");
    expect(dialog.textContent).toContain("lab");
    expect(dialog.textContent).toContain("已建好的工作区不受影响");
    // 事实行逐条在场（不是把地址塞进标题里一锅炖）
    expect(dialog.textContent).toContain("192.168.45.128:22");
    expect(dialog.textContent).toContain("root");
  });

  it("没有事实行时照常可用（删除对象不一定有附加信息）", () => {
    renderDialog({
      request: { subject: "这个文件", name: "a.txt", impact: "无法恢复。" },
    });
    const dialog = screen.getByTestId("confirm-delete-dialog");
    // 名字和影响范围被拆在同一段的两个节点里，按整段文本断言，别按单个元素
    expect(dialog.textContent).toContain("a.txt");
    expect(dialog.textContent).toContain("无法恢复。");
  });

  it("request 为 null 时整扇窗不存在（不能留一个空的模态挡住界面）", () => {
    renderDialog({ request: null });
    expect(screen.queryByTestId("confirm-delete-dialog")).toBeNull();
    expect(screen.queryByTestId("confirm-delete-action")).toBeNull();
  });
});

describe("ConfirmDeleteDialog — 点删除之前必须先点头", () => {
  /** 正向配对先做：证明确认按钮真的会删，下面那条"第一下不删"才有意义 */
  it("点「删除」才调 onConfirm，且只调一次", () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(screen.getByTestId("confirm-delete-action"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("点「取消」不删，只关窗", () => {
    const { onOpenChange, onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("确认按钮不许把 Radix 的默认关窗一起带上（关窗时机归调用方）", () => {
    // 删成了由调用方 setTarget(null) 才关；这里若被 Radix 顺手关掉，
    // busy 期间的"删除中…"和失败留窗都会失灵
    const { onOpenChange, onConfirm } = renderDialog();
    fireEvent.click(screen.getByTestId("confirm-delete-action"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("ConfirmDeleteDialog — 删除在飞的时候", () => {
  it("两颗按钮都禁用、文案改成「删除中…」、再点也不重复提交", () => {
    const { onConfirm } = renderDialog({ busy: true });
    const action = screen.getByTestId("confirm-delete-action");
    expect(action).toHaveProperty("disabled", true);
    expect(action.textContent).toContain("删除中");
    expect(
      screen.getByRole("button", { name: "取消" }).hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(action);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("在飞时按 Escape 不关窗（关掉了就看不见结果，删除却照跑）", () => {
    const { onOpenChange } = renderDialog({ busy: true });
    fireEvent.keyDown(screen.getByTestId("confirm-delete-dialog"), {
      key: "Escape",
    });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("空闲时按 Escape 走取消路径", () => {
    const { onOpenChange, onConfirm } = renderDialog();
    fireEvent.keyDown(screen.getByTestId("confirm-delete-dialog"), {
      key: "Escape",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 接线断言：删除确认只有一个主人（#166 ③）
// ----------------------------------------------------------------------------
// "同一种动作两种长相"是审查里最难发现的那类缺陷 —— 每一处单独看都挑不出毛病。
// 所以这里不测行为，测**没有第二份实现**：三个删除入口必须都接这只窗，
// 旧的"再点一次才删"必须整类消失。
// 判据的输入是 CI 检出的源码（不是本机才有的产物），扫描范围自己剪掉测试与 node_modules。
// ============================================================================
describe("ConfirmDeleteDialog — 删除确认只有一个主人", () => {
  const deleteSites = [
    "modules/spaces/components/SpaceCreateDialog.tsx",
    "modules/snippets/SnippetsPanel.tsx",
    "modules/explorer/FileExplorer.tsx",
  ];

  // 正向配对先做：没有这两条，下面"旧写法扫不到"会因为"压根没接线"而假绿
  it.each(deleteSites)("每一处删除都真的接上了这只窗：%s", (rel) => {
    const text = src(rel);
    expect(text).toContain('from "@/components/ConfirmDeleteDialog"');
    expect(text).toContain("<ConfirmDeleteDialog");
  });

  it("仓里不许再有第二种删除确认写法（行内'再点一次'那一类）", () => {
    const banned = ["Click again to confirm", "再次点击确认删除", "删除这条本机凭据"];
    const hits: string[] = [];
    for (const rel of deleteSites) {
      const text = codeOnly(src(rel));
      for (const phrase of banned) {
        if (text.includes(phrase)) hits.push(`${rel}: ${phrase}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("片段面板不再自己写一份删除弹窗", () => {
    const text = codeOnly(src("modules/snippets/SnippetsPanel.tsx"));
    expect(text).not.toContain("function DeleteConfirmDialog");
    // 文案搬进纯函数（面板文件导出非组件会让 react-refresh 失效），仍然说得出"不可恢复"
    const wording = src("modules/snippets/lib/snippetConfirmation.ts");
    expect(wording).toContain("无法恢复");
  });
});
