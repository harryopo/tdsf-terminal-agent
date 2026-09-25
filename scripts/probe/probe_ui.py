#!/usr/bin/env python3
"""真机 UI 审计：通过 CDP 在 dev 实例里量七类"看不见的显示缺陷"。

背景：这类缺陷（文字被裁切、对比度不足、命中区过小、图标按钮没有可访问名）
在 jsdom 里量不出来——jsdom 不做布局。只有真机 webview 的 scrollWidth /
getBoundingClientRect 才是事实。本脚本就是这个事实的门禁。

用法：
    pnpm probe:ui                      # 与基线比较，变差即非零退出
    pnpm probe:ui -- --update-baseline # 重新记基线（修完之后收紧）
    pnpm probe:ui -- --viewport 430x290 --scenario min-window

前置：pnpm tauri:dev 已经起着（9222 只在 dev 配置里开放）。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cdp  # noqa: E402

BASELINE = Path(__file__).resolve().parent / "ui-baseline.json"

RULES = (
    "clippedText",
    "inputTextOverflow",
    "lowContrast",
    "smallHitTarget",
    "missingName",
    "dividerMisaligned",
    "controlOutsideLeftCluster",
)

# 一次性在页面里跑完全部规则，只把违规项带回来（终端 xterm 子树整体跳过：
# 那是自绘网格，overflow:hidden 是它自己的滚动语义，不是显示缺陷）。
AUDIT_JS = r"""
(() => {
  const SKIP = '.xterm, .xterm-viewport, .xterm-scrollable-y, [data-probe-ignore]';
  // 先关掉过渡/动画再量：否则元素会停在动画中间态，同一份 UI 两次运行
  // 计数就会抖，门禁要么是假绿要么是假红。量完立刻撤掉，不改变运行时观感。
  const freeze = document.createElement('style');
  freeze.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(freeze);
  const out = {
    meta: { url: location.href, w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    rules: {},
  };
  // **样本量必须随读数一起报**：0 违规有两种——"真的没问题"和"现场压根没东西可量"。
  // 停在欢迎页时 body 里只有两百来个字符，七条规则全绿量的是一空气
  // （#130：一个空读数伪装成大缺陷；这里是它反过来骗人）。
  out.meta.audited = [...document.querySelectorAll('body *')].filter(
    (el) => !el.closest(SKIP)).length;
  // 缩放这条轴到底覆盖到谁：只有带 zoom 的那一层的后代元素会随 --app-zoom 变，
  // 顶栏与侧栏不在里面 ⇒ "横扫缩放"对它们的读数不会多覆盖任何东西。
  const zoomHost = [...document.querySelectorAll('body *')].find(
    (el) => { const z = getComputedStyle(el).zoom; return z && z !== '1'; });
  out.meta.zoomHost = zoomHost
    ? zoomHost.tagName.toLowerCase() + '.' + String(zoomHost.className || '').trim().split(/\s+/)[0]
    : null;
  out.meta.zoomable = zoomHost
    ? [...document.querySelectorAll('body *')].filter(
        (el) => !el.closest(SKIP) && zoomHost.contains(el)).length
    : 0;
  for (const k of ['clippedText', 'inputTextOverflow', 'lowContrast', 'smallHitTarget', 'missingName', 'dividerMisaligned', 'controlOutsideLeftCluster']) {
    out.rules[k] = { count: 0, samples: [] };
  }
  const bump = (k, el, detail) => {
    const r = out.rules[k];
    r.count += 1;
    if (r.samples.length < 15) {
      let sel = el.tagName.toLowerCase();
      if (el.id) sel += '#' + el.id;
      else if (el.className && typeof el.className === 'string') {
        sel += '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
      }
      r.samples.push({ sel, text: (el.textContent || el.placeholder || '').trim().slice(0, 40), detail });
    }
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return false;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    return true;
  };
  const hasOwnText = (el) => Array.from(el.childNodes).some(
    (n) => n.nodeType === 3 && n.textContent.trim().length > 0);

  // ── 1. 文本被裁切 ────────────────────────────────────────────────
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest(SKIP) || !visible(el) || !hasOwnText(el)) continue;
    const clipX = el.scrollWidth > el.clientWidth + 1;
    const clipY = el.scrollHeight > el.clientHeight + 1;
    if (!clipX && !clipY) continue;
    const cs = getComputedStyle(el);
    if (/(scroll|auto)/.test(cs.overflowX + cs.overflowY)) continue; // 可滚动是有意为之
    if (cs.textOverflow === 'ellipsis' && el.hasAttribute('data-allow-truncate')) continue;
    bump('clippedText', el, {
      axis: clipX && clipY ? 'xy' : clipX ? 'x' : 'y',
      scroll: clipX ? el.scrollWidth : el.scrollHeight,
      client: clipX ? el.clientWidth : el.clientHeight,
    });
  }

  // ── 2. input 里的占位符/值放不下（裁切规则量不到 input）──────────
  const measurer = document.createElement('canvas').getContext('2d');
  for (const el of document.querySelectorAll('input, textarea')) {
    if (el.closest(SKIP) || !visible(el)) continue;
    const cs = getComputedStyle(el);
    const text = el.value || el.placeholder;
    if (!text) continue;
    const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    if (avail <= 0) continue;
    measurer.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const need = measurer.measureText(text).width;
    if (need > avail + 1) {
      bump('inputTextOverflow', el, { need: Math.round(need), avail: Math.round(avail), on: el.value ? 'value' : 'placeholder' });
    }
  }

  // ── 3. 对比度 ────────────────────────────────────────────────────
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (r, g, b) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a.r, a.g, a.b), l2 = lum(b.r, b.g, b.b);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  };
  // 逐层向上合成背景（忽略中间层 opacity 链，只对纯色背景可靠）；
  // 链上出现 background-image / 渐变时结论不可信，直接跳过而不是报错。
  const bgOf = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      if (getComputedStyle(n).backgroundImage !== 'none') return null;
      const c = parse(getComputedStyle(n).backgroundColor);
      if (!c) continue;
      stack.push(c);
      if (c.a >= 0.999) break;
    }
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    for (const c of stack.reverse()) {
      acc = { r: c.r * c.a + acc.r * (1 - c.a), g: c.g * c.a + acc.g * (1 - c.a), b: c.b * c.a + acc.b * (1 - c.a), a: 1 };
    }
    return acc;
  };
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest(SKIP) || !visible(el) || !hasOwnText(el)) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg || fg.a < 0.05) continue;
    const bg = bgOf(el);
    if (!bg) continue;
    const fontPx = parseFloat(cs.fontSize) || 16;
    const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
    const large = fontPx >= 24 || (fontPx >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const got = ratio({ ...fg, r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) }, bg);
    if (got < need - 0.01) bump('lowContrast', el, { ratio: Number(got.toFixed(2)), need, px: Math.round(fontPx) });
  }

  // ── 4. 命中区过小 + 5. 可访问名缺失 ──────────────────────────────
  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [onclick]';
  const nameOf = (el) => {
    const lab = el.getAttribute('aria-label');
    if (lab && lab.trim()) return lab.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim(); if (t) return t; }
    const txt = (el.textContent || '').trim();
    if (txt) return txt;
    const own = (el.value || el.title || el.placeholder || el.getAttribute('alt') || '').trim();
    if (own) return own;
    const near = el.labels && el.labels[0] ? el.labels[0].textContent.trim() : '';
    return near;
  };
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (el.closest(SKIP) || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) {
      // rect 小于 24 不等于"点不中"：Radix Switch 这类别有 `after:-inset-*` 伪元素
      // 扩展区，CSS 命中测试会把落在伪元素上的点击交给宿主元素 —— 量具只看
      // getBoundingClientRect 就会把 68×36 的可点区误报成 44×20 的缺陷。
      // 判据是"拇指能不能点中"，所以直接做四角真命中测试（±12px = 24×24 的半幅）。
      // 只认两种命中：点到了它本身，或点到它的子节点（点击会冒泡到宿主 = 真能触发）。
      // **祖先被命中不算** —— 第一版写了 `t.contains(el)`，于是父容器的 padding 也把
      // 21px 高的按钮判成"点得中"，两处真缺陷当场假绿 0 违规。量具放水的代价是
      // 缺陷永久隐身，所以这条判据要往严里定。
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const corners = [[cx - 12, cy - 12], [cx + 12, cy - 12], [cx - 12, cy + 12], [cx + 12, cy + 12]];
      const unreachable = corners.filter(([x, y]) => {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true; // 贴边算不出就当作打不中
        const t = document.elementFromPoint(x, y);
        return !(t && (t === el || el.contains(t)));
      });
      if (unreachable.length) {
        bump('smallHitTarget', el, {
          w: Math.round(r.width), h: Math.round(r.height), miss: unreachable.length,
        });
      }
    }
    if (!nameOf(el)) bump('missingName', el, { role: el.getAttribute('role') || el.tagName.toLowerCase() });
  }
  // ── 6. 顶栏分隔线与侧栏右边界没对齐 ──────────────────────────────
  // 这两条线本该是同一条（用户 2026-09-20 实测差几十像素）。jsdom 不做布局，
  // 只有真机能量，所以把它钉成探针规则而不是快照。
  // 注意不能用上面的 visible()：它把宽 <3px 的元素当不可见，而分隔线正好是
  // 1px —— 第一版因此永远跳过、报 0 违规，是量具自己造出来的假绿。这里只要求
  // 侧栏面板真的占地方（折叠时宽为 0，两条线没有可比性，如实跳过）。
  //
  // **为什么要横扫缩放**：2026-09-21 用户又报没对齐，而只量当前一档的探针报 0
  // 违规 —— 漏的就是「改缩放之后」。旧实现把缩放系数写在消费方（CSS 变量存的是
  // react-resizable-panels 的布局像素），改缩放会让面板重新布局却常常不触发
  // onResize，变量停在旧值：CDP 实测同一窗口 1.05→1.2 歪 +44px、切回来歪 −70px。
  // 横扫几档就把这类「只在换算里成立」的写法钉死。
  {
    const dv = document.querySelector('[data-testid="header-divider"]');
    const sp = document.querySelector('[data-testid="sidebar-panel"]');
    const root = document.documentElement;
    const origZoom = root.style.getPropertyValue('--app-zoom');
    const restore = () => {
      if (origZoom) root.style.setProperty('--app-zoom', origZoom);
      else root.style.removeProperty('--app-zoom');
    };
    const deltas = {};
    try {
      for (const z of [origZoom || '1', '1.2', '0.9']) {
        root.style.setProperty('--app-zoom', z);
        // 改完立刻读 rect：强制同步布局，量的是这一档缩放下的真实位置
        const spRect = sp && sp.getBoundingClientRect();
        if (!dv || !spRect || spRect.width <= 3) break;
        const bw = parseFloat(getComputedStyle(sp).borderRightWidth) || 0;
        // 侧栏那条线的左边缘 = 面板右边缘 - border 宽；分隔线要落在同一列
        const delta = dv.getBoundingClientRect().left - (spRect.right - bw);
        deltas[z] = Math.round(delta * 10) / 10;
        if (Math.abs(delta) > 1) {
          bump('dividerMisaligned', dv, {
            deltaPx: deltas[z],
            zoom: z,
            dividerLeft: Math.round(dv.getBoundingClientRect().left),
            sidebarLineLeft: Math.round(spRect.right - bw),
          });
        }
      }
    } finally {
      restore();
    }
    out.meta.dividerDeltaPx = deltas[origZoom || '1'] ?? null;
    out.meta.dividerDeltaByZoom = deltas;
  }
  // ── 7. 顶栏左簇那两个控件（⌘ / 通知）没贴在左簇右边界 ──────────────
  // 用户 2026-09-21 说的「通知那俩 UI 右对齐」= **顶栏左簇（宽度跟着侧栏）的最右侧**，
  // 不是窗口右端。第一版理解错了搬到右簇，被当场退回，所以这句原话钉成规则：
  //   ① 两个控件必须整体在分隔线左边（不许跑到窗口那头）
  //   ② 最右那个（通知）必须顶着左簇右边界（不许缩在簇中间 —— 那是改动前的旧位置）
  // jsdom 不做布局，这条只有真机能量，判据与规则 6 同源。
  {
    const cluster = document.querySelector('[data-testid="header-left-cluster"]');
    const cr = cluster && cluster.getBoundingClientRect();
    if (cr && cr.width > 0) {
      for (const sel of ['header-command-palette', 'header-notification-bell']) {
        const el = document.querySelector(`[data-testid="${sel}"]`);
        if (!el) {
          bump('controlOutsideLeftCluster', cluster, { reason: `左簇里找不到 ${sel}` });
          continue;
        }
        const r = el.getBoundingClientRect();
        if (r.right > cr.right + 1) {
          bump('controlOutsideLeftCluster', el, {
            reason: '跑出了左簇', control: sel,
            controlRight: Math.round(r.right), clusterRight: Math.round(cr.right),
          });
        } else if (sel === 'header-notification-bell' && cr.right - r.right > 2) {
          bump('controlOutsideLeftCluster', el, {
            reason: '没有顶到左簇右边界', control: sel,
            gapPx: Math.round((cr.right - r.right) * 10) / 10,
          });
        }
      }
    }
  }
  freeze.remove();
  return out;
})()
"""


def _set_viewport(page: cdp.CdpPage, width: int, height: int) -> str:
    """返回实际生效的方式；失败就退回真实窗口尺寸继续量。"""
    try:
        page.call(
            "Emulation.setDeviceMetricsOverride",
            {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False},
        )
        return f"emulated {width}x{height}"
    except Exception as e:  # noqa: BLE001 - 模拟器不可用时如实说明而非造假
        print(f"  ! 无法模拟视口（{e}），改用当前窗口尺寸")
        return "native window"


def _clear_viewport(page: cdp.CdpPage) -> None:
    try:
        page.call("Emulation.clearDeviceMetricsOverride")
    except Exception:  # noqa: BLE001
        pass


def _wait_ready(page: cdp.CdpPage, expression: str, timeout_s: float = 30.0) -> None:
    """等 UI 真的渲染出来再量。

    启动早期 React 还没挂上，此时量会得到"0 违规"的假绿——必须显式等，
    而不是靠 sleep。超时不报错，让后续审计如实暴露空页面。
    """
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if page.evaluate(expression):
                return
        except Exception:  # noqa: BLE001 - 页面刚导航时求值可能失败，重试即可
            pass
        time.sleep(0.5)
    print("  ! 等待 UI 就绪超时，以下结果可能不完整")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--scenario", default="default")
    ap.add_argument("--viewport", default="", help="形如 430x290，用 CDP 视口模拟")
    ap.add_argument(
        "--wait-for",
        default="document.readyState === 'complete' && document.body.children.length > 0",
        help="UI 就绪判据（JS 表达式）。默认只等页面完成且有内容：拿按钮个数或 #root "
        "当判据会把控件少、挂载节点不同的窗口（设置窗）永远等超时。",
    )
    ap.add_argument("--update-baseline", action="store_true")
    args = ap.parse_args()
    # Windows 控制台默认 cp936，报告里的中文会成乱码——固定按 UTF-8 输出
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    pages = cdp.probe_port()
    baseline = json.loads(BASELINE.read_text("utf-8")) if BASELINE.exists() else {}
    new_entry: dict[str, dict[str, int]] = {}
    regressions: list[str] = []

    for target in pages:
        # 基线 key 必须稳定：document.title 会随活动标签页变（"shell" / 应用名），
        # 用它会每轮都取不到上一轮的计数，门禁就悄悄失效了。URL 才可靠。
        key = target["url"].split("#")[0].rstrip("/") or "/"
        title = target.get("title") or key
        page = cdp.connect(target)
        try:
            how = ""
            if args.viewport:
                w, _, h = args.viewport.partition("x")
                how = f" [{_set_viewport(page, int(w), int(h))}]"
            _wait_ready(page, args.wait_for)
            report = page.evaluate(AUDIT_JS)
            entry = {k: report["rules"][k]["count"] for k in RULES}
            new_entry[key + how] = entry
            m = report["meta"]
            print(
                f"[{title} {key}{how}] {m['w']}x{m['h']} dpr={round(m['dpr'], 2)} "
                f"可量元素 {m.get('audited')}（随 --app-zoom 变的 {m.get('zoomable')}"
                f"{'' if not m.get('zoomHost') else '，在 ' + str(m['zoomHost'])}）"
                f"违规：{entry}"
            )
            prev = baseline.get(args.scenario, {}).get(key + how)
            for k in RULES:
                if not entry[k]:
                    continue
                for s in report["rules"][k]["samples"][:6]:
                    print(f"    · {k} {s['sel']} {s['text']!r} {s['detail']}")
            if not args.update_baseline and prev:
                for k in RULES:
                    if entry[k] > prev.get(k, 0):
                        regressions.append(f"{key}{how} {k}: {prev.get(k, 0)} -> {entry[k]}")
        finally:
            _clear_viewport(page)
            page.close()

    if args.update_baseline:
        BASELINE.write_text(
            json.dumps({**baseline, args.scenario: new_entry}, ensure_ascii=False, indent=2) + "\n",
            "utf-8",
        )
        print(f"基线已写入 {BASELINE.name}（scenario={args.scenario}）")
        return 0

    if regressions:
        print("\nUI 门禁失败（相对基线变差）：")
        for line in regressions:
            print(f"  - {line}")
        return 1
    print("UI 门禁通过（无相对基线的退步）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
