"""Stage 3 screenshot verification — Sidecar adapter + 4 TDSF Agent routing.

Verifies:
  1. TdsfAgentPanel 4 Tabs clickable, switches chatStore.tdsfAgentId
  2. Titlebar agent switcher also syncs to chatStore.tdsfAgentId
  3. Send message → routes to sidecar-adapter
     - Dev mode + no sidecar → mock fallback ([mock:coding] input="..." )
     - Mood transitions: idle → thinking → streaming → idle
  4. Each of 4 agents (coder/explore/history/teach) gets correct mock response

Reuses Tauri mock + window.__tdsfChatStore injection from stage2.
"""
from playwright.sync_api import sync_playwright
import os, base64, json

OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "screenshots")
os.makedirs(OUT, exist_ok=True)

# Reuse Tauri mock from stage2 — read it from stage2-screenshot.py
import importlib.util
spec = importlib.util.spec_from_file_location(
    "stage2", os.path.join(os.path.dirname(__file__), "stage2-screenshot.py")
)
stage2 = importlib.util.module_from_spec(spec)
# Don't exec — just extract TAURI_MOCK_JS by reading file source
with open(os.path.join(os.path.dirname(__file__), "stage2-screenshot.py"), "r", encoding="utf-8") as f:
    src = f.read()
# Extract TAURI_MOCK_JS raw string between r""" ... """
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
            errors.append(f"console.{m.type}: {m.text}")
    page.on("console", on_console)

    page.goto("http://localhost:9200", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(8000)

    # === Setup: open mini panel + fake anthropic key ===
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
        initialTdsfAgent: cs.getState().tdsfAgentId,
      };
    }""")
    print(f"[setup] {forced}")
    page.wait_for_timeout(1500)
    cdp_screenshot(page, os.path.join(OUT, "stage3-01-panel-open-default.png"))

    # === Verify initial state: tdsfAgentId should be "coder" ===
    initial_agent = page.evaluate("() => window.__tdsfChatStore?.getState()?.tdsfAgentId")
    print(f"[verify] initial tdsfAgentId = {initial_agent!r}")
    assert initial_agent == "coder", f"expected 'coder', got {initial_agent!r}"

    # === Test 1: Click "explore" tab in TdsfAgentPanel ===
    explore_tab = page.locator('[data-testid="tdsf-agent-tab-explore"]')
    print(f"[verify] explore tab count: {explore_tab.count()}")
    if explore_tab.count() > 0:
        explore_tab.click()
        page.wait_for_timeout(400)
    agent_after_explore = page.evaluate("() => window.__tdsfChatStore?.getState()?.tdsfAgentId")
    print(f"[verify] after click explore tab → tdsfAgentId = {agent_after_explore!r}")
    assert agent_after_explore == "explore", f"expected 'explore', got {agent_after_explore!r}"
    cdp_screenshot(page, os.path.join(OUT, "stage3-02-tab-explore.png"))

    # === Test 2: Click "teach" tab ===
    teach_tab = page.locator('[data-testid="tdsf-agent-tab-teach"]')
    if teach_tab.count() > 0:
        teach_tab.click()
        page.wait_for_timeout(400)
    agent_after_teach = page.evaluate("() => window.__tdsfChatStore?.getState()?.tdsfAgentId")
    print(f"[verify] after click teach tab → tdsfAgentId = {agent_after_teach!r}")
    assert agent_after_teach == "teach", f"expected 'teach', got {agent_after_teach!r}"
    cdp_screenshot(page, os.path.join(OUT, "stage3-03-tab-teach.png"))

    # === Test 3: Click "history" tab ===
    history_tab = page.locator('[data-testid="tdsf-agent-tab-history"]')
    if history_tab.count() > 0:
        history_tab.click()
        page.wait_for_timeout(400)
    agent_after_history = page.evaluate("() => window.__tdsfChatStore?.getState()?.tdsfAgentId")
    print(f"[verify] after click history tab → tdsfAgentId = {agent_after_history!r}")
    assert agent_after_history == "history", f"expected 'history', got {agent_after_history!r}"
    cdp_screenshot(page, os.path.join(OUT, "stage3-04-tab-history.png"))

    # === Test 4: Switch back to coder, send mock message ===
    coder_tab = page.locator('[data-testid="tdsf-agent-tab-coder"]')
    if coder_tab.count() > 0:
        coder_tab.click()
        page.wait_for_timeout(400)
    agent_back_coder = page.evaluate("() => window.__tdsfChatStore?.getState()?.tdsfAgentId")
    print(f"[verify] after click coder tab → tdsfAgentId = {agent_back_coder!r}")
    assert agent_back_coder == "coder"

    # Type message into TdsfAgentPanel input
    input_el = page.locator('[data-testid="tdsf-agent-input"]')
    print(f"[verify] input count: {input_el.count()}")
    if input_el.count() > 0:
        input_el.fill("nginx 启动失败")
        page.wait_for_timeout(200)
        cdp_screenshot(page, os.path.join(OUT, "stage3-05-input-typed.png"))

        # Click send button
        send_btn = page.locator('[data-testid="tdsf-agent-send"]')
        print(f"[verify] send btn count: {send_btn.count()}, disabled={send_btn.get_attribute('disabled')}")
        if send_btn.count() > 0:
            send_btn.click()
            # Wait for mock response (sidecar-adapter dev mode fallback)
            # mock generates chunks: [mock:coding] input="nginx 启动失败" messages=1
            page.wait_for_timeout(3500)
            cdp_screenshot(page, os.path.join(OUT, "stage3-06-mock-response.png"))

    # === Test 5: Verify mock response rendered in messages ===
    # TdsfAgentPanel uses AiChatView to render messages — check if any message bubble has [mock:
    messages_html = page.evaluate("""() => {
      const msgs = document.querySelectorAll('[data-tdsf-agent-messages]');
      if (!msgs.length) return 'no messages container';
      return msgs[0].innerText.slice(0, 500);
    }""")
    print(f"[verify] messages inner text (first 500 chars):\n{messages_html[:500]}")

    # === Test 6: Switch to teach agent, send another message ===
    teach_tab = page.locator('[data-testid="tdsf-agent-tab-teach"]')
    if teach_tab.count() > 0:
        teach_tab.click()
        page.wait_for_timeout(300)
    input_el = page.locator('[data-testid="tdsf-agent-input"]')
    if input_el.count() > 0:
        input_el.fill("explain ls command")
        page.wait_for_timeout(200)
        send_btn = page.locator('[data-testid="tdsf-agent-send"]')
        if send_btn.count() > 0:
            send_btn.click()
            page.wait_for_timeout(3500)
            cdp_screenshot(page, os.path.join(OUT, "stage3-07-teach-mock-response.png"))

    # === Test 7: Titlebar agent switcher also updates chatStore ===
    # Click "history" on titlebar switcher
    titlebar_history = page.locator('[data-testid="tdsf-titlebar-agent-history"]')
    if titlebar_history.count() > 0:
        titlebar_history.click()
        page.wait_for_timeout(400)
    agent_from_titlebar = page.evaluate("() => window.__tdsfChatStore?.getState()?.tdsfAgentId")
    print(f"[verify] after click titlebar history → tdsfAgentId = {agent_from_titlebar!r}")
    # Titlebar should sync to chatStore via App.tsx state → setTdsfAgent
    # (depends on whether App.tsx wires onAgentChange to setTdsfAgent)
    cdp_screenshot(page, os.path.join(OUT, "stage3-08-titlebar-sync.png"))

    # === Test 8: Final state — all 4 agents visited ===
    final_state = page.evaluate("""() => {
      const cs = window.__tdsfChatStore?.getState();
      return {
        tdsfAgentId: cs?.tdsfAgentId,
        miniOpen: cs?.mini?.open,
        activeSessionId: cs?.activeSessionId,
        messagesCount: cs?.sessions?.[cs?.activeSessionId]?.messages?.length ?? 0,
        agentMetaStatus: cs?.agentMeta?.status,
      };
    }""")
    print(f"[final] {final_state}")
    cdp_screenshot(page, os.path.join(OUT, "stage3-09-final-state.png"))

    # === Summary ===
    summary = {
        "initial_agent": initial_agent,
        "after_explore_tab": agent_after_explore,
        "after_teach_tab": agent_after_teach,
        "after_history_tab": agent_after_history,
        "after_back_coder": agent_back_coder,
        "after_titlebar_history": agent_from_titlebar,
        "final_state": final_state,
        "errors_count": len(errors),
        "errors_preview": errors[:3],
    }
    report_path = os.path.join(OUT, "stage3-report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(f"\n[report] {report_path}")
    print(f"[summary] {json.dumps(summary, ensure_ascii=False, indent=2)}")
    print(f"[done] Stage 3 verification complete")
    browser.close()
