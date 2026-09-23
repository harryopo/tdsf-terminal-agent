"""真机门禁：弹窗的按钮等高 + 不许顶满 + 左列不留空洞 + 两列标签基线对齐。

为什么必须真机：happy-dom 不做布局，`getBoundingClientRect()` 全是 0，
"两个按钮差 4px""弹窗高到 93% 视口""列表下面那块空白"这类问题只能在 WebView2 里量出来。

为什么要"打不开就报错"：这类判据最阴的假绿是**弹窗根本没开，于是扫到 0 个按钮、
报 0 违规**。所以本脚本先自己把「新建工作区 → SSH 服务器」打开，打不开直接非零退出。

两条 2026-09-23 新增的几何判据（用户原话：「减少错位和留白异常，要对齐」）：
- `trailingHolePx`：左列最后一块内容到列底之间的空白。列表原来是固定 max-h，右侧表单比它高时
  下面就挂着一大块空白 → 这条量出来的就是这个洞。
- `labelTopDeltaPx`：左列标题与右列第一个字段标签的上边缘差。两列并排时不齐就是一眼可见的错位。

跑法：`pnpm probe:dialog`（dev 实例需在跑；CDP 9222 只在 dev 配置里开）
"""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cdp  # noqa: E402

# 按 innerText 精确点一个 BUTTON（React 的合成事件吃 el.click()，但这里够用；
# 与 outputs/ui_click_exact.py 同一口径，用真实鼠标事件更稳）。
CLICK_JS = r"""((label) => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 8 && r.height > 8 && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };
  const btn = [...document.querySelectorAll('button')].filter(vis).find(
    (b) => (b.innerText || '').trim().replace(/\s+/g, ' ') === label,
  );
  if (!btn) return { ok: false };
  const r = btn.getBoundingClientRect();
  return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})"""

MEASURE_JS = r"""(() => {
  const dlgs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 40;
  });
  if (!dlgs.length) return { dialogCount: 0 };
  const dlg = dlgs[dlgs.length - 1];
  const dr = dlg.getBoundingClientRect();
  const vis = (b) => {
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return r.width > 8 && r.height > 8 && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };
  // 只比**底部动作区**的按钮。行内小按钮（如"复制命令"、列表里的删除）
  // 本来就该比主按钮小，把它们算进"等高"判据会把正确的做法判成违规。
  const footer = dlg.querySelector('[data-slot="alert-dialog-footer"], [data-slot="dialog-footer"]');
  const footBtns = footer ? [...footer.querySelectorAll('button')].filter(vis) : [];
  const allBtns = [...dlg.querySelectorAll('button')].filter(vis);
  const heights = footBtns.map((b) => +b.getBoundingClientRect().height.toFixed(2));

  // 两条几何判据：左列的空洞、两列标签的基线差
  const col = dlg.querySelector('[data-testid="ssh-saved-column"]');
  const form = dlg.querySelector('[data-testid="ssh-form-column"]');
  let trailingHolePx = null;
  let labelTopDeltaPx = null;
  if (col && form) {
    const kids = [...col.children].filter(vis);
    if (kids.length) {
      const colR = col.getBoundingClientRect();
      const lastR = kids[kids.length - 1].getBoundingClientRect();
      trailingHolePx = +(colR.bottom - lastR.bottom).toFixed(1);
    }
    const l1 = [...col.querySelectorAll('label')].filter(vis)[0];
    const l2 = [...form.querySelectorAll('label')].filter(vis)[0];
    if (l1 && l2) {
      labelTopDeltaPx = +(l1.getBoundingClientRect().top - l2.getBoundingClientRect().top).toFixed(1);
    }
  }
  return {
    dialogCount: dlgs.length,
    viewportH: innerHeight,
    dialog: { w: Math.round(dr.width), h: Math.round(dr.height) },
    footerButtons: footBtns.map((b) => ({
      t: (b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 20),
      h: +b.getBoundingClientRect().height.toFixed(2),
    })),
    spread: heights.length ? +(Math.max(...heights) - Math.min(...heights)).toFixed(2) : 0,
    footerCount: footBtns.length,
    rowCount: dlg.querySelectorAll('[data-testid="saved-server-row"]').length,
    hasDeleteBtn: allBtns.some((b) => /删除 /.test(b.getAttribute('aria-label') || '')),
    trailingHolePx,
    labelTopDeltaPx,
  };
})()"""


def click(page, label: str) -> bool:
    loc = page.evaluate(f"{CLICK_JS}({json.dumps(label, ensure_ascii=False)})", await_promise=False)
    if not loc.get("ok"):
        return False
    for etype in ("mousePressed", "mouseReleased"):
        page.call(
            "Input.dispatchMouseEvent",
            {
                "type": etype,
                "x": loc["x"],
                "y": loc["y"],
                "button": "left",
                "clickCount": 1,
                "buttons": 1 if etype == "mousePressed" else 0,
            },
        )
    return True


def measure(page) -> dict:
    time.sleep(0.6)
    m = page.evaluate(MEASURE_JS)
    # 结构不对 = **脚本自己的问题**，绝不能报成"现场没有弹窗"。
    # 上一轮这条门禁就是这么哑的：MEASURE_JS 写成 (() => {...}) 少了一对调用括号，
    # evaluate 返回一个函数的序列化结果 {}，于是 dialogCount 永远取不到，
    # 探针永远输出"点了两下仍没有弹窗渲染出来"——查的人会被带去查弹窗，而不是查尺子。
    if not isinstance(m, dict) or "dialogCount" not in m:
        raise SystemExit(
            f"MEASURE_JS 没有返回预期结构（拿到 {type(m).__name__}: {str(m)[:80]}）"
            "—— 这是探针脚本自身的故障，不是界面问题。"
        )
    return m


KIND_JS = r"""(() => {
  const d = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 40;
  }).pop();
  if (!d) return { open: false };
  const text = (d.innerText || '').replace(/\s+/g, ' ');
  return {
    open: true,
    // 主机审批框是**安全提示**，探针按 Escape 就等于替用户点「拒绝」——绝不允许
    approval: /主机密钥已变更|首次连接该主机|信任并/.test(text),
  };
})()"""


def dialog_kind(page) -> dict:
    return page.evaluate(KIND_JS)


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    page = cdp.connect(cdp.probe_port()[0])

    # 开局就检查：有排队中的主机审批时**直接退出**，不按下 Escape。
    # （按下 Escape = 替用户回答一个安全提示，这是门禁不该有的权力。）
    kind = dialog_kind(page)
    if kind.get("approval"):
        raise SystemExit(
            "屏幕上正挂着主机密钥审批框 —— 本探针不替你回答安全提示。"
            "请先在窗口里处理它（核对指纹后信任，或明确拒绝），再跑 `pnpm probe:dialog`。"
        )
    if kind.get("open"):
        # 不是审批框（例如上一轮自己没关掉的建工作区弹窗）才允许关掉重来
        page.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "windowsVirtualKeyCode": 27})
        page.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Escape", "windowsVirtualKeyCode": 27})
        time.sleep(0.5)

    if not click(page, "新建工作区"):
        # 按钮"找不到"最常见的原因不是它不存在，而是**另一个模态正压在上面**
        # （主机密钥确认框就是这种）。报清楚，否则下一手会去查按钮的文案。
        stuck = page.evaluate(MEASURE_JS)
        hint = (
            f"当前有 {stuck['dialogCount']} 个模态弹窗压在上面（高 {stuck['dialog']['h']}px），"
            "先把排队中的审批处理掉再跑。"
            if stuck.get("dialogCount")
            else "页面上也没有弹窗，可能是页面尚未就绪。"
        )
        raise SystemExit("点不到「新建工作区」——没有可量的弹窗，本判据不许静默通过。" + hint)
    # 弹窗是 Radix 挂载的，点完立刻找选项卡会扑空（实测：不加这句就报"打不开 SSH 档"）
    time.sleep(1.0)
    if not click(page, "SSH 服务器"):
        raise SystemExit("打不开「SSH 服务器」这一档 —— 判据要的是字段最多的那一档，空跑不算过。")
    m = measure(page)
    if not m.get("dialogCount"):
        raise SystemExit("点了两下仍没有弹窗渲染出来 —— 现场不对，不算通过。")

    # 有已保存的服务器才谈得上"列表面板要撑满、删除入口要在位"；
    # 一条都没有时这两项判据无从成立，明确报出来而不是当成"通过"。
    problems: list[str] = []
    if m["rowCount"] == 0:
        problems.append(
            f"左列有 {m['rowCount']} 条已保存的服务器 —— 空洞/删除两条判据没有现场"
        )
    if m["footerCount"] < 2:
        # 没有底部动作区 = 这条判据无从成立。报出来，别让它当成"0 违规"通过。
        problems.append(f"底部动作区里只找到 {m['footerCount']} 个按钮 —— 判据没有现场")
    elif m["spread"] > 1.0:
        problems.append(
            f"底部按钮高度差 {m['spread']}px: "
            + ", ".join(f"{b['t']}={b['h']}" for b in m["footerButtons"])
        )
    ratio = m["dialog"]["h"] / m["viewportH"]
    if ratio > 0.72:
        problems.append(
            f"弹窗高 {m['dialog']['h']}px = 视口 {m['viewportH']}px 的 {ratio:.0%}（>72%，顶满窗口）"
        )
    if m["trailingHolePx"] is None:
        problems.append("量不到左列（ssh-saved-column 不在现场）—— 判据没有现场")
    elif m["trailingHolePx"] > 4.0:
        problems.append(
            f"左列底部残留 {m['trailingHolePx']}px 空洞（>4px，列表没随行高撑满）"
        )
    if m["labelTopDeltaPx"] is None:
        problems.append("量不到两列的标签（ssh-form-column 或左列标题不在现场）")
    elif abs(m["labelTopDeltaPx"]) > 1.0:
        problems.append(
            f"左列标题与右列首个字段标签上边缘差 {m['labelTopDeltaPx']}px（>1px，两列不齐）"
        )

    print(json.dumps(m, ensure_ascii=False))
    # 收尾只关自己打开的那个；万一一轮量完又冒出审批框，同样不碰
    if not dialog_kind(page).get("approval"):
        page.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "windowsVirtualKeyCode": 27})
        page.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Escape", "windowsVirtualKeyCode": 27})

    if problems:
        print("弹窗门禁失败：")
        for p in problems:
            print(f"  - {p}")
        print("PROBE_DIALOG FAIL")
        return 1
    print(
        f"判据: 底部按钮高度差 {m['spread']}px | 弹窗高占视口 {ratio:.0%} | "
        f"左列底部空洞 {m['trailingHolePx']}px | 两列标签基线差 {m['labelTopDeltaPx']}px | "
        f"已保存 {m['rowCount']} 条、删除入口 {m['hasDeleteBtn']}"
    )
    print("PROBE_DIALOG PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
