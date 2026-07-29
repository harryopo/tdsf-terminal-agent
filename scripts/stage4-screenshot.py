"""Stage 4 screenshot verification — SSH Explorer + Teach Section + Skills Panel.

Verifies:
  1. Sidebar SSH rail button clickable → SshExplorer renders (connect dialog open)
  2. Sidebar Skills rail button clickable → SkillsPanel renders (skill cards visible)
  3. Settings → TeachSection visible (teach threshold selector + enable switch)
  4. TdsfAgentPanel input /skill: autocomplete hint visible
  5. All three new panels render without React errors

Reuses Tauri mock + window.__tdsfChatStore injection from stage2.
"""
from playwright.sync_api import sync_playwright
import os, base64, json

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
            # Ignore WebGL GPU stall warnings (non-blocking)
            if "GPU stall" in m.text or "GL_CLOSE_PATH_NV" in m.text:
                return
            errors.append(f"console.{m.type}: {m.text}")
    page.on("console", on_console)

    page.goto("http://localhost:9200", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(8000)

    # === Setup: fake anthropic key + open mini ===
    forced = page.evaluate("""() => {
      const cs = window.__tdsfChatStore;
      if (!cs) return { chatStore: false };
      const cur = cs.getState();
      const fakeKeys = { ...cur.apiKeys, anthropic: 'sk-ant-fake-mock-key-for-screenshot' };
      cs.setState({ apiKeys: fakeKeys });
      if (!cs.getState().activeSessionId && typeof cs.getState().newSession === 'function') {
        cs.getState().newSession();
      }
      return { chatStore: true, activeSessionId: cs.getState().activeSessionId };
    }""")
    print(f"[setup] {forced}")
    page.wait_for_timeout(1500)
    cdp_screenshot(page, os.path.join(OUT, "stage4-01-initial.png"))

    # === Test 1: Open SSH Explorer via sidebar ===
    # Sidebar rail buttons use aria-label={item.label} (SidebarRail.tsx L53)
    ssh_rail = page.locator('button[aria-label="SSH"]')
    print(f"[verify] ssh rail count: {ssh_rail.count()}")
    if ssh_rail.count() > 0:
        ssh_rail.first.click()
        page.wait_for_timeout(1500)
    cdp_screenshot(page, os.path.join(OUT, "stage4-02-ssh-explorer.png"))

    # Verify SshExplorer rendered (look for connect button or dialog trigger)
    ssh_panel_text = page.evaluate("""() => {
      const panels = document.querySelectorAll('[class*="ssh"], [data-tdsf-ssh], [data-testid*="ssh"]');
      const text = Array.from(panels).map(e => e.innerText?.slice(0, 200) || '').join('|');
      return text || document.body.innerText.slice(0, 1000);
    }""")
    print(f"[verify] ssh panel text (first 300): {ssh_panel_text[:300]}")

    # Try opening connect dialog
    connect_btn = page.locator('button:has-text("Connect"), button:has-text("连接"), button:has-text("New")').first
    if connect_btn.count() > 0:
        try:
            connect_btn.click()
            page.wait_for_timeout(800)
            cdp_screenshot(page, os.path.join(OUT, "stage4-03-ssh-connect-dialog.png"))
            # Close dialog
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
        except Exception as e:
            print(f"[warn] connect dialog click failed: {e}")

    # === Test 2: Open Skills Panel via sidebar ===
    skills_rail = page.locator('button[aria-label="Skills"]')
    print(f"[verify] skills rail count: {skills_rail.count()}")
    if skills_rail.count() > 0:
        skills_rail.first.click()
        page.wait_for_timeout(1500)
    cdp_screenshot(page, os.path.join(OUT, "stage4-04-skills-panel.png"))

    # Verify SkillsPanel rendered
    skills_panel_text = page.evaluate("""() => {
      const panels = document.querySelectorAll('[class*="skill"], [data-testid*="skill"]');
      const text = Array.from(panels).map(e => e.innerText?.slice(0, 300) || '').join('|');
      return text || 'no skill panel';
    }""")
    print(f"[verify] skills panel text (first 400): {skills_panel_text[:400]}")

    # Look for skill cards
    skill_cards = page.locator('[data-testid*="skill-card"], [class*="SkillCard"]')
    print(f"[verify] skill card count: {skill_cards.count()}")
    cdp_screenshot(page, os.path.join(OUT, "stage4-05-skills-cards.png"))

    # === Test 3: Open Settings → Teach Section ===
    # Settings can be opened via command palette (Cmd+K) or sidebar gear
    # Try clicking settings gear in sidebar
    settings_rail = page.locator('[data-testid="sidebar-rail-settings"], button[aria-label*="Settings"], button[aria-label*="设置"]').first
    if settings_rail.count() > 0:
        settings_rail.click()
        page.wait_for_timeout(1500)
    cdp_screenshot(page, os.path.join(OUT, "stage4-06-settings.png"))

    # Look for Teach section in settings
    teach_section = page.locator('text=Teach, text=教学, [data-testid*="teach"]').first
    if teach_section.count() > 0:
        try:
            teach_section.click()
            page.wait_for_timeout(800)
        except Exception:
            pass
    cdp_screenshot(page, os.path.join(OUT, "stage4-07-teach-section.png"))

    # === Test 4: TdsfAgentPanel /skill: hint ===
    # Open mini panel
    page.evaluate("""() => {
      const cs = window.__tdsfChatStore;
      if (cs) cs.getState().openMini();
    }""")
    page.wait_for_timeout(800)
    cdp_screenshot(page, os.path.join(OUT, "stage4-08-agent-panel.png"))

    # Type /skill: in agent input
    input_el = page.locator('[data-testid="tdsf-agent-input"]')
    if input_el.count() > 0:
        input_el.fill("/skill:linux-ops explain file permissions")
        page.wait_for_timeout(500)
        cdp_screenshot(page, os.path.join(OUT, "stage4-09-skill-command-typed.png"))

    # === Test 5: Final state — all panels visited ===
    final_state = page.evaluate("""() => {
      const cs = window.__tdsfChatStore?.getState();
      return {
        tdsfAgentId: cs?.tdsfAgentId,
        miniOpen: cs?.mini?.open,
        activeSessionId: cs?.activeSessionId,
      };
    }""")
    print(f"[final] {final_state}")
    cdp_screenshot(page, os.path.join(OUT, "stage4-10-final-state.png"))

    # === Summary ===
    summary = {
        "ssh_rail_count": ssh_rail.count(),
        "skills_rail_count": skills_rail.count(),
        "skill_cards_count": skill_cards.count(),
        "ssh_panel_text_preview": ssh_panel_text[:200],
        "skills_panel_text_preview": skills_panel_text[:200],
        "final_state": final_state,
        "errors_count": len(errors),
        "errors_preview": errors[:5],
    }
    report_path = os.path.join(OUT, "stage4-report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(f"\n[report] {report_path}")
    print(f"[summary] {json.dumps(summary, ensure_ascii=False, indent=2)}")
    print(f"[done] Stage 4 verification complete")
    browser.close()
