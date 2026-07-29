"""Stage 5 — Complete Playwright screenshot suite for TDSF Terminal Agent.

Covers 10 key UI surfaces (magic-clone-v0-detailed-plan.md §T5.2 + T4.x new panels):
  1. Titlebar + Agent switcher
  2. Local FileExplorer
  3. Terminal pane (xterm)
  4. AI floating panel (TdsfAgentPanel + 4 Agent tabs)
  5. Settings (emerald theme)
  6. Command palette (Cmd+K)
  7. Source Control panel
  8. SSH Explorer (T4.1)
  9. Skills Panel (T4.4)
 10. Teach settings section (T4.3)

Reuses Tauri mock + window.__tdsfChatStore injection from stage2.
"""
from playwright.sync_api import sync_playwright
import os, base64, json

OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "screenshots")
os.makedirs(OUT, exist_ok=True)

with open(os.path.join(os.path.dirname(__file__), "stage2-screenshot.py"), "r", encoding="utf-8") as f:
    src = f.read()
start = src.index('TAURI_MOCK_JS = r"""') + len('TAURI_MOCK_JS = r"""')
end = src.index('"""', start)
TAURI_MOCK_JS = src[start:end]


def cdp_screenshot(page, path):
    """Take screenshot via CDP — no font-ready wait."""
    client = page.context.new_cdp_session(page)
    result = client.send("Page.captureScreenshot", {"format": "png"})
    with open(path, "wb") as f:
        f.write(base64.b64decode(result["data"]))
    print(f"[shot] {os.path.basename(path)} saved")


def click_sidebar(page, label: str, wait_ms: int = 1200):
    """Click sidebar rail button by aria-label."""
    btn = page.locator(f'button[aria-label="{label}"]').first
    if btn.count() > 0:
        btn.click()
        page.wait_for_timeout(wait_ms)
        return True
    return False


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script(TAURI_MOCK_JS)
    page = ctx.new_page()
    page.set_default_timeout(60000)

    errors = []
    def on_pageerror(e):
        errors.append(f"PAGE_ERROR: {e.message}\nSTACK:\n{e.stack}")
    page.on("pageerror", on_pageerror)
    def on_console(m):
        if m.type in ("error", "warning"):
            if "GPU stall" in m.text or "GL_CLOSE_PATH_NV" in m.text:
                return
            errors.append(f"console.{m.type}: {m.text[:200]}")
    page.on("console", on_console)

    page.goto("http://localhost:9200", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(8000)

    # === Setup: fake anthropic key + active session ===
    page.evaluate("""() => {
      const cs = window.__tdsfChatStore;
      if (!cs) return;
      const cur = cs.getState();
      const fakeKeys = { ...cur.apiKeys, anthropic: 'sk-ant-fake-mock-key-for-screenshot' };
      cs.setState({ apiKeys: fakeKeys });
      if (!cs.getState().activeSessionId) cs.getState().newSession();
    }""")
    page.wait_for_timeout(1500)

    shots_taken = []

    # === 1. Titlebar + Agent switcher ===
    cdp_screenshot(page, os.path.join(OUT, "stage5-01-titlebar.png"))
    shots_taken.append("01-titlebar")

    # === 2. Local FileExplorer ===
    if click_sidebar(page, "Files", 1500):
        cdp_screenshot(page, os.path.join(OUT, "stage5-02-file-explorer.png"))
        shots_taken.append("02-file-explorer")

    # === 3. Terminal pane ===
    if click_sidebar(page, "Terminal", 1500) or click_sidebar(page, "终端", 1500):
        cdp_screenshot(page, os.path.join(OUT, "stage5-03-terminal.png"))
        shots_taken.append("03-terminal")
    else:
        # Fallback: click first rail button (usually terminal)
        first_rail = page.locator('button[aria-label]').first
        if first_rail.count() > 0:
            first_rail.click()
            page.wait_for_timeout(1500)
            cdp_screenshot(page, os.path.join(OUT, "stage5-03-terminal.png"))
            shots_taken.append("03-terminal")

    # === 4. AI floating panel (TdsfAgentPanel) ===
    page.evaluate("""() => {
      const cs = window.__tdsfChatStore;
      if (cs) cs.getState().openMini();
    }""")
    page.wait_for_timeout(1000)
    cdp_screenshot(page, os.path.join(OUT, "stage5-04-ai-panel.png"))
    shots_taken.append("04-ai-panel")
    # Click teach tab to show variant
    teach_tab = page.locator('[data-testid="tdsf-agent-tab-teach"]').first
    if teach_tab.count() > 0:
        teach_tab.click()
        page.wait_for_timeout(500)
        cdp_screenshot(page, os.path.join(OUT, "stage5-04b-ai-panel-teach.png"))
    # Close mini
    page.evaluate("""() => {
      const cs = window.__tdsfChatStore;
      if (cs) cs.getState().closeMini();
    }""")
    page.wait_for_timeout(400)

    # === 5. Settings (emerald theme) ===
    if click_sidebar(page, "Settings", 1500) or click_sidebar(page, "设置", 1500):
        cdp_screenshot(page, os.path.join(OUT, "stage5-05-settings.png"))
        shots_taken.append("05-settings")
        # Try clicking Themes section
        themes_tab = page.locator('text=Themes, text=主题').first
        if themes_tab.count() > 0:
            try:
                themes_tab.click()
                page.wait_for_timeout(800)
                cdp_screenshot(page, os.path.join(OUT, "stage5-05b-settings-themes.png"))
            except Exception:
                pass

    # === 6. Command palette (Ctrl+P or Cmd+K) ===
    page.keyboard.press("Control+k")
    page.wait_for_timeout(1500)
    cdp_screenshot(page, os.path.join(OUT, "stage5-06-command-palette.png"))
    shots_taken.append("06-command-palette")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)

    # === 7. Source Control panel ===
    if click_sidebar(page, "Source Control", 1500) or click_sidebar(page, "Git", 1500):
        cdp_screenshot(page, os.path.join(OUT, "stage5-07-source-control.png"))
        shots_taken.append("07-source-control")

    # === 8. SSH Explorer (T4.1) ===
    if click_sidebar(page, "SSH", 1500):
        cdp_screenshot(page, os.path.join(OUT, "stage5-08-ssh-explorer.png"))
        shots_taken.append("08-ssh-explorer")
        # Try opening connect dialog
        connect_btn = page.locator('button:has-text("Connect"), button:has-text("连接"), button:has-text("新建连接")').first
        if connect_btn.count() > 0:
            try:
                connect_btn.click()
                page.wait_for_timeout(800)
                cdp_screenshot(page, os.path.join(OUT, "stage5-08b-ssh-connect-dialog.png"))
                page.keyboard.press("Escape")
                page.wait_for_timeout(400)
            except Exception:
                pass

    # === 9. Skills Panel (T4.4) ===
    if click_sidebar(page, "Skills", 1500):
        cdp_screenshot(page, os.path.join(OUT, "stage5-09-skills-panel.png"))
        shots_taken.append("09-skills-panel")
        # Click first skill "详情" to open details
        detail_btn = page.locator('button:has-text("详情")').first
        if detail_btn.count() > 0:
            try:
                detail_btn.click()
                page.wait_for_timeout(800)
                cdp_screenshot(page, os.path.join(OUT, "stage5-09b-skill-details.png"))
                page.keyboard.press("Escape")
                page.wait_for_timeout(400)
            except Exception:
                pass

    # === 10. Teach settings section (T4.3) ===
    if click_sidebar(page, "Settings", 1500) or click_sidebar(page, "设置", 1500):
        # Look for Teach / General section
        general_tab = page.locator('text=General, text=通用').first
        if general_tab.count() > 0:
            try:
                general_tab.click()
                page.wait_for_timeout(800)
            except Exception:
                pass
        cdp_screenshot(page, os.path.join(OUT, "stage5-10-teach-settings.png"))
        shots_taken.append("10-teach-settings")

    # === Summary ===
    summary = {
        "shots_taken": shots_taken,
        "shots_count": len(shots_taken),
        "errors_count": len(errors),
        "errors_preview": errors[:5],
    }
    report_path = os.path.join(OUT, "stage5-report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(f"\n[report] {report_path}")
    print(f"[summary] {json.dumps(summary, ensure_ascii=False, indent=2)}")
    print(f"[done] Stage 5 screenshot suite complete — {len(shots_taken)} shots, {len(errors)} errors")
    browser.close()
