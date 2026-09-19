#!/usr/bin/env python3
"""真机 UI 审计：通过 CDP 在 dev 实例里量四类"看不见的显示缺陷"。

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

RULES = ("clippedText", "inputTextOverflow", "lowContrast", "smallHitTarget", "missingName")

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
  for (const k of ['clippedText', 'inputTextOverflow', 'lowContrast', 'smallHitTarget', 'missingName']) {
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
    if (r.width < 24 || r.height < 24) bump('smallHitTarget', el, { w: Math.round(r.width), h: Math.round(r.height) });
    if (!nameOf(el)) bump('missingName', el, { role: el.getAttribute('role') || el.tagName.toLowerCase() });
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
        default="document.querySelectorAll('button,input').length > 20",
        help="UI 就绪判据（JS 表达式）",
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
            print(f"[{title} {key}{how}] {m['w']}x{m['h']} dpr={round(m['dpr'], 2)} 违规：{entry}")
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
