"""真机门禁：弹窗的按钮等高 + 不许顶满窗口高度 + SSH 档左列两个操作按钮在位。

为什么必须真机：happy-dom 不做布局，`getBoundingClientRect()` 全是 0，
"两个按钮差 4px""弹窗高到 93% 视口"这类问题只能在 WebView2 里量出来。

为什么要"打不开就报错"：这类判据最阴的假绿是**弹窗根本没开，于是扫到 0 个按钮、
报 0 违规**。所以本脚本先自己把「新建工作区 → SSH 服务器」打开，打不开直接非零退出。

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
  // 只比**底部动作区**的按钮。行内小按钮（如"复制命令"、列表里的详情/删除）
  // 本来就该比主按钮小，把它们算进"等高"判据会把正确的做法判成违规。
  const footer = dlg.querySelector('[data-slot="alert-dialog-footer"], [data-slot="dialog-footer"]');
  const footBtns = footer ? [...footer.querySelectorAll('button')].filter(vis) : [];
  const allBtns = [...dlg.querySelectorAll('button')].filter(vis);
  const heights = footBtns.map((b) => +b.getBoundingClientRect().height.toFixed(2));
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
    hasDetailBtn: allBtns.some((b) => /查看 .* 详情/.test(b.getAttribute('aria-label') || '')),
    hasDeleteBtn: allBtns.some((b) => /删除 /.test(b.getAttribute('aria-label') || '')),
  };
})"""


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
    return page.evaluate(MEASURE_JS)


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

    # 有已保存的服务器才谈得上左列两个按钮；一条都没有时这两项判据无从成立，
    # 明确报出来而不是当成"通过"。
    saved = m["hasDetailBtn"] or m["hasDeleteBtn"]

    problems: list[str] = []
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
    if not saved:
        problems.append("左列没有「详情 / 删除」两个操作按钮 —— 已保存服务器的管理入口不在位")

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
        f"判据: 底部按钮高度差 {m['spread']}px | 弹窗高占视口 {ratio:.0%} | 左列详情/删除在位"
    )
    print("PROBE_DIALOG PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
