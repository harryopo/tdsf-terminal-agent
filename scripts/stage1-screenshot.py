"""Stage 1 screenshot verification — brand + emerald theme + logo.
Uses CDP captureScreenshot to bypass Playwright font-ready wait."""
from playwright.sync_api import sync_playwright
import os, base64

OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "screenshots")
os.makedirs(OUT, exist_ok=True)

def cdp_screenshot(page, path):
    """Take screenshot via CDP — no font-ready wait."""
    client = page.context.new_cdp_session(page)
    result = client.send("Page.captureScreenshot", {"format": "png"})
    with open(path, "wb") as f:
        f.write(base64.b64decode(result["data"]))
    print(f"[shot] {os.path.basename(path)} saved")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    page.set_default_timeout(60000)

    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto("http://localhost:9200", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(5000)  # React mount + Vite HMR

    root = page.locator(":root")

    # Screenshot 1: Dark mode (default)
    cdp_screenshot(page, os.path.join(OUT, "stage1-01-initial-dark.png"))

    # Verify emerald colors
    primary = root.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()")
    bg = root.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim()")
    print(f"[verify] dark  --primary={primary}  --background={bg}")

    title = page.title()
    print(f"[verify] title={title}")

    # Screenshot 2: Light mode
    page.evaluate("() => document.documentElement.classList.remove('dark')")
    page.wait_for_timeout(800)
    cdp_screenshot(page, os.path.join(OUT, "stage1-02-light-mode.png"))
    light_primary = root.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()")
    print(f"[verify] light --primary={light_primary}")

    # Screenshot 3: Dark back
    page.evaluate("() => document.documentElement.classList.add('dark')")
    page.wait_for_timeout(800)
    cdp_screenshot(page, os.path.join(OUT, "stage1-03-dark-mode.png"))

    if errors:
        print(f"[warn] {len(errors)} page errors: {errors[:3]}")
    else:
        print("[ok] no page errors")

    browser.close()
    print("[done] Stage 1 verification complete")
