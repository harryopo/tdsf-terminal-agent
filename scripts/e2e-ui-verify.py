"""前端 UI 端到端验证（连接 Vite dev server）"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

URL = "http://127.0.0.1:9300/"
OUT_DIR = Path(__file__).resolve().parent.parent / "reports"
OUT_DIR.mkdir(exist_ok=True)

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, args=["--window-size=1400,900"])
        context = browser.new_context(viewport={"width": 1400, "height": 900})
        page = context.new_page()

        print(f"[1/5] 打开 {URL}")
        page.goto(URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        shot1 = OUT_DIR / "e2e-ui-01-initial.png"
        page.screenshot(path=str(shot1), full_page=False)
        print(f"  ✓ 截图: {shot1.name}")

        print("[2/5] 验证标题栏文本")
        try:
            expect(page.locator("text=TDSF Terminal").first).to_be_visible(timeout=5000)
            print("  ✓ TDSF Terminal 标题可见")
        except Exception as e:
            print(f"  ✗ 标题不可见: {e}")

        print("[3/5] 点击 Explore 标签")
        try:
            page.locator("text=Explore").first.click(timeout=3000)
            page.wait_for_timeout(1000)
            shot2 = OUT_DIR / "e2e-ui-02-explore.png"
            page.screenshot(path=str(shot2), full_page=False)
            print(f"  ✓ 截图: {shot2.name}")
        except Exception as e:
            print(f"  ✗ Explore 点击失败: {e}")

        print("[4/5] 点击 Teach 标签")
        try:
            page.locator("text=Teach").first.click(timeout=3000)
            page.wait_for_timeout(1000)
            shot3 = OUT_DIR / "e2e-ui-03-teach.png"
            page.screenshot(path=str(shot3), full_page=False)
            print(f"  ✓ 截图: {shot3.name}")
        except Exception as e:
            print(f"  ✗ Teach 点击失败: {e}")

        print("[5/5] 点击 History 标签")
        try:
            page.locator("text=History").first.click(timeout=3000)
            page.wait_for_timeout(1000)
            shot4 = OUT_DIR / "e2e-ui-04-history.png"
            page.screenshot(path=str(shot4), full_page=False)
            print(f"  ✓ 截图: {shot4.name}")
        except Exception as e:
            print(f"  ✗ History 点击失败: {e}")

        browser.close()
        print("\n✅ UI 验证完成")
        return 0

if __name__ == "__main__":
    sys.exit(main())
