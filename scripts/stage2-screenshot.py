"""Stage 2 screenshot verification — TdsfTitlebar + TdsfAgentPanel + emerald theme.

Uses CDP captureScreenshot to bypass Playwright font-ready wait (same trick as
stage1-screenshot.py).

Goal:
  1. Verify TdsfTitlebar renders (logo, project name, mood, 4 Agent switcher,
     time, window controls).
  2. Verify TdsfAgentPanel renders (mood face, 4 agent tabs, input bar, send
     button, hint row).
  3. Verify emerald palette (CSS vars --primary, --background).
  4. Verify 4 agent switcher clicks switch active tab.

Since dev server has no Tauri backend, we inject a comprehensive Tauri mock
via addInitScript so React tree can mount normally. The mock returns sensible
defaults for invoke calls (empty arrays, nulls) so component-level catches
keep the tree alive.
"""
from playwright.sync_api import sync_playwright
import os, base64, json

OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "screenshots")
os.makedirs(OUT, exist_ok=True)

# Tauri internals mock — injected before any page script runs.
# Returns sensible defaults for invoke() so React tree doesn't crash.
TAURI_MOCK_JS = r"""
(function() {
  const cbMap = new Map();
  let cbId = 0;
  const invokeHandlers = {
    // PTY / shell — return empty / null
    'pty_close_all': () => null,
    'pty_list': () => [],
    'pty_spawn': () => null,
    'pty_write': () => null,
    'pty_resize': () => null,
    'pty_close': () => null,
    'workspace_current_dir': () => null,
    'workspace_authorize': () => null,
    'get_launch_dir': () => null,
    'get_launch_files': () => [],
    // Secrets / keyring — fake anthropic key so hasComposer becomes true
    'secrets_get_all': (args) => {
      const accts = args?.accounts ?? [];
      return accts.map((a) => {
        if (a === 'anthropic-api-key') return 'sk-ant-fake-mock-key-for-screenshot';
        return null;
      });
    },
    'secrets_get': (args) => {
      if (args?.account === 'anthropic-api-key') return 'sk-ant-fake-mock-key-for-screenshot';
      return null;
    },
    'secrets_set': () => null,
    'secrets_delete': () => null,
    // Agent hooks — no-op
    'agent_enable_hooks': () => null,
    // IPC for Python sidecar — fail-open (sidecar unavailable in dev)
    'ipc_invoke': () => { throw new Error('sidecar unavailable in dev'); },
    // FS — return empty
    'fs_list': () => [],
    'fs_read_file': () => '',
    'fs_write_file': () => null,
    'fs_watch': () => null,
    'fs_unwatch': () => null,
    'fs_mkdir': () => null,
    'fs_rename': () => null,
    'fs_remove': () => null,
    'fs_stat': () => null,
    // Git
    'git_status': () => null,
    'git_diff': () => '',
    'git_log': () => [],
    // Window ops — no-op
    'plugin:window|show': () => null,
    'plugin:window|hide': () => null,
    'plugin:window|close': () => null,
    'plugin:window|minimize': () => null,
    'plugin:window|maximize': () => null,
    'plugin:window|unmaximize': () => null,
    'plugin:window|set_title': () => null,
    'plugin:window|start_dragging': () => null,
    'plugin:window|set_focus': () => null,
    // Event — return fake event id with unlisten fn
    'plugin:event|listen': () => ({ event: 'mock', id: Math.floor(Math.random() * 1e6) }),
    'plugin:event|unlisten': () => null,
    'plugin:event|emit': () => null,
    // Store (plugin-store) — LazyStore.get returns [value, exists] tuple
    'plugin:store|get': (args) => {
      const key = args?.key;
      // Array-typed values — return [empty_array, true] so caller gets []
      if (key === 'sessions' || key === 'snippets' || key === 'terax-sessions' || key === 'themes' || key === 'custom-themes' || key === 'agents' || key === 'recent-cmds') return [[], true];
      // Object-typed values — return [{}, true]
      if (key === 'preferences' || key === 'preferences.json' || key === 'settings') return [{}, true];
      // Default: not exists
      return [null, false];
    },
    'plugin:store|set': () => null,
    'plugin:store|save': () => null,
    'plugin:store|delete': () => null,
    'plugin:store|keys': () => [],
    'plugin:store|values': () => [],
    'plugin:store|entries': () => [],
    'plugin:store|length': () => 0,
    'plugin:store|clear': () => null,
    'plugin:store|reset': () => null,
    'plugin:store|has': () => false,
    'plugin:store|create': () => ({ rid: 1 }),
    // Updater
    'plugin:updater|check': () => null,
    // Notification
    'plugin:notification|request_permission': () => 'granted',
    'plugin:notification|notify': () => null,
    // OS
    'plugin:os|platform': () => 'windows',
    'plugin:os|locale': () => 'en-US',
    'plugin:os|hostname': () => 'localhost',
    // Clipboard
    'plugin:clipboard|read_text': () => '',
    'plugin:clipboard|write_text': () => null,
    // Opener
    'plugin:opener|open_url': () => null,
    // Autostart
    'plugin:autostart|enable': () => null,
    'plugin:autostart|disable': () => null,
    'plugin:autostart|is_enabled': () => false,
    // Log
    'plugin:log|trace': () => null,
    'plugin:log|debug': () => null,
    'plugin:log|info': () => null,
    'plugin:log|warn': () => null,
    'plugin:log|error': () => null,
    // Window-state
    'plugin:window-state|save_window_state': () => null,
    'plugin:window-state|restore_state': () => null,
  };
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main', windowLabel: 'main' },
    },
    invoke: async function(cmd, args, options) {
      // Small delay to mimic async IPC.
      await new Promise(r => setTimeout(r, 1));
      const handler = invokeHandlers[cmd];
      if (handler) return handler(args);
      // Default: return null (most commands tolerate null)
      console.debug('[tauri-mock] invoke:', cmd, '→ null');
      return null;
    },
    transformCallback: function(cb, once) {
      const id = ++cbId;
      cbMap.set(id, cb);
      return id;
    },
    unregisterCallback: function(id) {
      cbMap.delete(id);
    },
    convertFileSrc: function(path, protocol) {
      return path;
    },
  };
  // Event plugin internals — needed by @tauri-apps/api/event _unlisten
  const listeners = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    registerListener: function(evt, handler) {
      const id = Math.floor(Math.random() * 1e6);
      if (!listeners.has(evt)) listeners.set(evt, new Map());
      listeners.get(evt).set(id, handler);
      return id;
    },
    unregisterListener: function(evt, id) {
      listeners.get(evt)?.delete(id);
    },
  };
})();
"""

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
    # Inject Tauri mock BEFORE any page script runs
    ctx.add_init_script(TAURI_MOCK_JS)
    page = ctx.new_page()
    page.set_default_timeout(60000)

    errors = []
    def on_pageerror(e):
        errors.append(f"PAGE_ERROR: {e.message}\nSTACK:\n{e.stack}")
    page.on("pageerror", on_pageerror)
    def on_console(m):
        if m.type in ("error", "warning"):
            errors.append(f"console.{m.type}: {m.text}\n  location: {m.location}")
    page.on("console", on_console)

    page.goto("http://localhost:9200", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(8000)  # React mount + Vite HMR + bootstrap + init effects

    # Diagnostic: dump #root children + body classes
    root_html = page.evaluate("() => document.getElementById('root')?.innerHTML?.slice(0, 2000) ?? 'NO ROOT'")
    print(f"[diag] root html (first 2000 chars):\n{root_html[:2000]}")
    body_classes = page.evaluate("() => document.body.className")
    html_attrs = page.evaluate("() => Array.from(document.documentElement.attributes).map(a => a.name + '=' + a.value).join(', ')")
    print(f"[diag] body class: {body_classes}")
    print(f"[diag] html attrs: {html_attrs}")

    root = page.locator(":root")

    # ===== Screenshot 1: Initial state (Titlebar + sidebar + workspace) =====
    cdp_screenshot(page, os.path.join(OUT, "stage2-01-initial.png"))

    # Verify TdsfTitlebar is present
    titlebar = page.locator("[data-tauri-drag-region]")
    print(f"[verify] titlebar count: {titlebar.count()}")

    # Verify mood testid
    mood_el = page.locator('[data-testid="tdsf-titlebar-mood"]')
    print(f"[verify] titlebar mood count: {mood_el.count()}")
    if mood_el.count() > 0:
        mood_text = mood_el.inner_text()
        print(f"[verify] titlebar mood: {mood_text!r}")

    # Verify 4 agent switcher
    agent_switcher = page.locator('[data-testid="tdsf-titlebar-agent-switcher"]')
    print(f"[verify] agent switcher count: {agent_switcher.count()}")
    agents = ["coder", "explore", "history", "teach"]
    for a in agents:
        btn = page.locator(f'[data-testid="tdsf-titlebar-agent-{a}"]')
        print(f"[verify] titlebar agent {a}: {btn.count()}")

    # Verify emerald primary color
    primary = root.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()")
    bg = root.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim()")
    print(f"[verify] --primary={primary}  --background={bg}")

    # ===== Screenshot 2: Click "Explore" agent (switch active) =====
    explore_btn = page.locator('[data-testid="tdsf-titlebar-agent-explore"]')
    if explore_btn.count() > 0:
        explore_btn.click()
        page.wait_for_timeout(400)
        cdp_screenshot(page, os.path.join(OUT, "stage2-02-agent-explore.png"))

    # Click "Teach" agent
    teach_btn = page.locator('[data-testid="tdsf-titlebar-agent-teach"]')
    if teach_btn.count() > 0:
        teach_btn.click()
        page.wait_for_timeout(400)
        cdp_screenshot(page, os.path.join(OUT, "stage2-03-agent-teach.png"))

    # ===== Screenshot 4: Open TdsfAgentPanel via window.__tdsfChatStore =====
    # dev helper (main.tsx) mounts useChatStore to window.__tdsfChatStore
    # We force-open mini AND set fake apiKeys so hasComposer becomes true
    forced = page.evaluate("""() => {
      const cs = window.__tdsfChatStore;
      if (!cs) return { chatStore: false };
      // Set fake apiKeys so hasAnyKey() returns true → hasComposer=true
      const cur = cs.getState();
      const fakeKeys = { ...cur.apiKeys, anthropic: 'sk-ant-fake-mock-key-for-screenshot' };
      cs.setState({ apiKeys: fakeKeys });
      // Open mini panel
      cs.getState().openMini();
      // Also force-create a session so sessionId is non-null
      if (!cs.getState().activeSessionId) {
        // If openMini doesn't auto-create session, manually create one
        if (typeof cs.getState().newSession === 'function') {
          cs.getState().newSession();
        }
      }
      return {
        chatStore: true,
        miniOpen: cs.getState().mini.open,
        activeSessionId: cs.getState().activeSessionId,
        apiKeysAnthropic: cs.getState().apiKeys?.anthropic?.slice(0, 20),
      };
    }""")
    print(f"[force] {forced}")
    page.wait_for_timeout(1500)  # wait for PresenceState mount animation
    cdp_screenshot(page, os.path.join(OUT, "stage2-04-mini-panel-open.png"))

    # Check if TdsfAgentPanel rendered
    agent_panel = page.locator('[data-tdsf-agent-panel]')
    print(f"[verify] agent panel count: {agent_panel.count()}")
    if agent_panel.count() > 0:
        # Verify mood face and 4 tabs
        mood_face = page.locator('[data-testid="tdsf-agent-mood-face"]')
        print(f"[verify] agent panel mood face count: {mood_face.count()}")
        if mood_face.count() > 0:
            print(f"[verify] agent panel mood face: {mood_face.inner_text()!r}")
        # Verify 4 agent tabs
        for a in agents:
            tab = page.locator(f'[data-testid="tdsf-agent-tab-{a}"]')
            print(f"[verify] agent panel tab {a}: {tab.count()}")
        # Verify input
        inp = page.locator('[data-testid="tdsf-agent-input"]')
        print(f"[verify] agent panel input: {inp.count()}")
        # Screenshot 5: switch to Explore tab
        explore_tab = page.locator('[data-testid="tdsf-agent-tab-explore"]')
        if explore_tab.count() > 0:
            explore_tab.click()
            page.wait_for_timeout(400)
            cdp_screenshot(page, os.path.join(OUT, "stage2-05-agent-panel-explore.png"))
        # Screenshot 6: switch to Teach tab
        teach_tab = page.locator('[data-testid="tdsf-agent-tab-teach"]')
        if teach_tab.count() > 0:
            teach_tab.click()
            page.wait_for_timeout(400)
            cdp_screenshot(page, os.path.join(OUT, "stage2-06-agent-panel-teach.png"))

    # ===== Screenshot 7: Open settings (use .first to avoid strict mode) =====
    settings_btn = page.locator('button[title="设置"], button[title="Settings"]').first
    if settings_btn.count() > 0:
        try:
            settings_btn.click(timeout=2000)
            page.wait_for_timeout(1500)
            cdp_screenshot(page, os.path.join(OUT, "stage2-07-settings.png"))
        except Exception as e:
            print(f"[warn] could not open settings: {e}")

    # ===== Summary =====
    if errors:
        print(f"\n[warn] {len(errors)} console/page errors captured (first 3 FULL):")
        for e in errors[:3]:
            print(f"--- ERROR ---\n{e}\n")
    else:
        print("\n[ok] no console/page errors")

    # Save verification report
    report = {
        "titlebar_present": titlebar.count() > 0,
        "mood_present": mood_el.count() > 0,
        "agent_switcher_present": agent_switcher.count() > 0,
        "agents_visible": {a: page.locator(f'[data-testid="tdsf-titlebar-agent-{a}"]').count() > 0 for a in agents},
        "primary_color": primary,
        "background_color": bg,
        "agent_panel_rendered": agent_panel.count() > 0,
        "errors_count": len(errors),
    }
    report_path = os.path.join(OUT, "stage2-report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"\n[report] {report_path}")
    print(f"[summary] {json.dumps(report, ensure_ascii=False)}")

    browser.close()
    print("[done] Stage 2 verification complete")
