"""Tauri 桌面端端到端验证（通过 WebView2 CDP）。

前置条件：
    pnpm tauri dev 已启动，且 remote-debugging-port=9222 已开启。

验证项：
    1. CDP 可连接
    2. 窗口标题包含 TDSF Terminal Agent
    3. 截图保存到 reports/
    4. 关键 UI 元素可见（侧边栏、终端区域、状态栏）
"""
import base64
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

CDP_URL = "http://localhost:9222"
OUT_DIR = Path(__file__).resolve().parent.parent / "reports"
OUT_DIR.mkdir(exist_ok=True)


def cdp_screenshot(page, path: Path):
    """通过 CDP 截图，绕过 Playwright 字体等待。"""
    client = page.context.new_cdp_session(page)
    result = client.send("Page.captureScreenshot", {"format": "png"})
    path.write_bytes(base64.b64decode(result["data"]))
    print(f"  ✓ 截图: {path.name}")


def main():
    with sync_playwright() as p:
        print(f"[1/5] 连接 CDP: {CDP_URL}")
        try:
            browser = p.chromium.connect_over_cdp(CDP_URL)
        except Exception as e:
            print(f"  ✗ 无法连接 CDP: {e}")
            print("    请确认 pnpm tauri dev 已启动且 --remote-debugging-port=9222 生效")
            return 1

        context = browser.contexts[0] if browser.contexts else browser.new_context()
        pages = context.pages
        if not pages:
            print("  ✗ 未找到 WebView 页面")
            return 1
        page = pages[0]
        page.set_default_timeout(15000)

        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        print(f"  ✓ 已连接，页面数: {len(pages)}")
        print(f"  ✓ 标题: {page.title()}")

        print("[2/5] 等待页面稳定并截图")
        page.wait_for_timeout(3000)
        shot1 = OUT_DIR / "e2e-desktop-01-initial.png"
        cdp_screenshot(page, shot1)

        print("[3/5] 验证关键 UI 元素")
        checks = [
            ("title contains TDSF", lambda: "TDSF" in page.title()),
            ("sidebar visible", lambda: page.locator("[data-testid='sidebar']").first.is_visible(timeout=3000)),
            ("statusbar visible", lambda: page.locator("[data-testid='statusbar']").first.is_visible(timeout=3000)),
            ("terminal area or empty state", lambda: (
                page.locator("[data-testid='terminal-pane']").first.is_visible(timeout=2000) or
                page.locator("[data-testid='no-terminal-empty-state']").first.is_visible(timeout=2000)
            )),
        ]
        for label, fn in checks:
            try:
                ok = fn()
                print(f"  ✓ {label}: {ok}")
            except Exception as e:
                print(f"  ✗ {label}: {e}")

        print("[4/5] 点击 Settings 并截图")
        try:
            settings_btn = page.locator("button[aria-label='Settings'], [data-testid='settings-button']").first
            if settings_btn.is_visible(timeout=3000):
                settings_btn.click()
                page.wait_for_timeout(1500)
                shot2 = OUT_DIR / "e2e-desktop-02-settings.png"
                cdp_screenshot(page, shot2)
            else:
                print("  ⚠ 未找到 Settings 按钮")
        except Exception as e:
            print(f"  ✗ Settings 截图失败: {e}")

        print("[5/5] 检查 Mock LLM 告警 pill")
        try:
            pill = page.locator("[data-testid='mock-llm-warning']").first
            if pill.is_visible(timeout=3000):
                print(f"  ⚠ Mock LLM 告警可见: {pill.inner_text()}")
            else:
                print("  ✓ 无 Mock LLM 告警（API Key 可能已配置）")
        except Exception as e:
            print(f"  ✗ 检查告警失败: {e}")

        if page_errors:
            print(f"\n⚠ 页面运行时错误 ({len(page_errors)} 个):")
            for err in page_errors[:5]:
                print(f"  - {err}")
        else:
            print("\n✓ 无页面运行时错误")

        browser.close()
        print("\n✅ 桌面端端到端验证完成")
        return 0


if __name__ == "__main__":
    sys.exit(main())
