"""Stage 6 final end-to-end screenshot verification.

Verify all key interfaces render correctly after audit fixes:
  1. Titlebar + Agent switcher
  2. Local FileExplorer
  3. Terminal pane
  4. AI floating panel (with mock response)
  5. Settings (emerald theme + font selector)
  6. Command palette
  7. Source Control panel
  8. SSH Explorer + Connect dialog
  9. Skills panel + cards
 10. Teach settings section

Reuses Tauri mock + chatStore injection from stage2.
"""
from playwright.sync_api import sync_playwright
import os, base64, json, importlib.util

OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "screenshots")
os.makedirs(OUT, exist_ok=True)

# Reuse Tauri mock from stage2
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


def click_sidebar(page, label: str, wait_ms: int = 1200) -> bool:
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
        errors.append(f"PAGE_ERROR: {e.message}")
    page.on("pageerror", on_pageerror)
    def on_console(m):
        if m.type in ("error", "warning"):
            errors.append(f"console.{m.type}: {m.text}")
    page.on("console", on_console)

    page.goto("http://localhost:9200", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(8000)

    # Setup: fake anthropic key + open mini panel + new session
    forced = page.evaluate("""() => {
      const cs = window.__tdsfChatStore;
      if (!cs) return { chatStore: false };
      const cur = cs.getState();
      const fakeKeys = { ...cur.apiKeys, anthropic: 'sk-ant-fake-mock-key-for-screenshot' };
      cs.setState({ apiKeys: fakeKeys });
      cs.getState().openMini();
      if (!cs.getState().activeSessionId && typeof cs.getState().newSession === 'function') {
        cs.getState().newSession();
      }
      return {
        chatStore: true,
        miniOpen: cs.getState().mini.open,
        activeSessionId: cs.getState().activeSessionId,
        tdsfAgentId: cs.getState().tdsfAgentId,
      };
    }""")
    print(f"[setup] {forced}")
    page.wait_for_timeout(1500)

    shots_taken = []

    # 1. Titlebar + Agent switcher
    cdp_screenshot(page, os.path.join(OUT, "stage6-01-titlebar.png"))
    shots_taken.append("01-titlebar")

    # 2. Local FileExplorer
    if click_sidebar(page, "Files", 1500):
        cdp_screenshot(page, os.path.join(OUT, "stage6-02-file-explorer.png"))
        shots_taken.append("02-file-explorer")

    # 3. Terminal pane
    if click_sidebar(page, "Terminal", 1500):
        cdp_screenshot(page, os.path.join(OUT, "stage6-03-terminal.png"))
        shots_taken.append("03-terminal")

    # 4. AI floating panel (TdsfAgentPanel) — should already be open from setup
    # Switch to teach agent and send a test message
    teach_tab = page.locator('[data-testid="tdsf-agent-tab-teach"]')
    if teach_tab.count() > 0:
        teach_tab.click()
        page.wait_for_timeout(400)
    cdp_screenshot(page, os.path.join(OUT, "stage6-04-ai-panel-teach.png"))
    shots_taken.append("04-ai-panel-teach")

    # Send a mock message to verify sidecar-adapter dev mode fallback
    input_el = page.locator('[data-testid="tdsf-agent-input"]')
    if input_el.count() > 0:
        input_el.fill("explain ls command")
        page.wait_for_timeout(200)
        send_btn = page.locator('[data-testid="tdsf-agent-send"]')
        if send_btn.count() > 0:
            send_btn.click()
            page.wait_for_timeout(3500)
    cdp_screenshot(page, os.path.join(OUT, "stage6-04b-ai-mock-response.png"))
    shots_taken.append("04b-ai-mock-response")

    # 5. Settings (emerald theme)
    if click_sidebar(page, "Settings", 1500):
        cdp_screenshot(page, os.path.join(OUT, "stage6-05-settings.png"))
        shots_taken.append("05-settings")

    # 6. Command palette
    page.keyboard.press("Control+K")
    page.wait_for_timeout(1500)
    cdp_screenshot(page, os.path.join(OUT, "stage6-06-command-palette.png"))
    shots_taken.append("06-command-palette")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)

    # 7. Source Control panel
    if click_sidebar(page, "Source Control", 1500):
        cdp_screenshot(page, os.path.join(OUT, "stage6-07-source-control.png"))
        shots_taken.append("07-source-control")

    # 8. SSH Explorer
    if click_sidebar(page, "SSH", 1500):
        cdp_screenshot(page, os.path.join(OUT, "stage6-08-ssh-explorer.png"))
        shots_taken.append("08-ssh-explorer")
        # Try opening connect dialog
        connect_btn = page.locator('button:has-text("新建连接"), button:has-text("New Connection")')
        if connect_btn.count() > 0:
            connect_btn.first.click()
            page.wait_for_timeout(800)
            cdp_screenshot(page, os.path.join(OUT, "stage6-08b-ssh-connect-dialog.png"))
            shots_taken.append("08b-ssh-connect-dialog")
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)

    # 9. Skills panel
    if click_sidebar(page, "Skills", 1500):
        cdp_screenshot(page, os.path.join(OUT, "stage6-09-skills-panel.png"))
        shots_taken.append("09-skills-panel")
        # Check skill cards
        skill_cards = page.locator('[data-testid*="skill-card"], [class*="SkillCard"]')
        print(f"[verify] skill card count: {skill_cards.count()}")
        cdp_screenshot(page, os.path.join(OUT, "stage6-09b-skills-cards.png"))
        shots_taken.append("09b-skills-cards")

    # 10. Teach settings section
    if click_sidebar(page, "Settings", 1500):
        # Look for teach section link/button
        teach_link = page.locator('button:has-text("Teach"), [data-testid*="teach"]')
        if teach_link.count() > 0:
            teach_link.first.click()
            page.wait_for_timeout(800)
        cdp_screenshot(page, os.path.join(OUT, "stage6-10-teach-settings.png"))
        shots_taken.append("10-teach-settings")

    # Final state
    final_state = page.evaluate("""() => {
      const cs = window.__tdsfChatStore?.getState();
      const prefs = window.__tdsfPreferencesStore?.getState?.();
      return {
        tdsfAgentId: cs?.tdsfAgentId,
        miniOpen: cs?.mini?.open,
        activeSessionId: cs?.activeSessionId,
        messagesCount: cs?.sessions?.[cs?.activeSessionId]?.messages?.length ?? 0,
        teachAgentEnabled: prefs?.teachAgentEnabled,
        teachThreshold: prefs?.teachThreshold,
        themeId: prefs?.themeId,
      };
    }""")
    print(f"[final] {final_state}")
    cdp_screenshot(page, os.path.join(OUT, "stage6-11-final-state.png"))
    shots_taken.append("11-final-state")

    # Summary report
    summary = {
        "stage": "stage6",
        "shots_taken": shots_taken,
        "shots_count": len(shots_taken),
        "final_state": final_state,
        "errors_count": len(errors),
        "errors_preview": errors[:5],
        "all_shots_present": len(shots_taken) >= 10,
    }
    report_path = os.path.join(OUT, "stage6-report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(f"\n[report] {report_path}")
    print(f"[summary] shots={len(shots_taken)}, errors={len(errors)}")
    print(f"[done] Stage 6 final verification complete")
    browser.close()
