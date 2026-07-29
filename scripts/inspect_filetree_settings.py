import json
import requests
import websocket
import time

CDP = "http://localhost:9222"
targets = requests.get(f"{CDP}/json/list", timeout=5).json()
page = [t for t in targets if t.get("type") == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=15)

_id = [0]
def send(method, params=None):
    _id[0] += 1
    m = {"id": _id[0], "method": method}
    if params:
        m["params"] = params
    ws.send(json.dumps(m))
    return _id[0]

def eval_expr(expr):
    req = send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    deadline = time.time() + 5
    while time.time() < deadline:
        ws.settimeout(max(0.1, deadline - time.time()))
        try:
            raw = ws.recv()
        except websocket.WebSocketTimeoutException:
            continue
        data = json.loads(raw)
        if data.get("id") == req:
            return data
    return None

send("Runtime.enable")
time.sleep(1)

# Click SSH
eval_expr("""
(()=>{
  const btns = Array.from(document.querySelectorAll('button'));
  const b = btns.find(x => x.innerText.trim() === 'SSH');
  if (b) b.click();
  return true;
})()
""")
time.sleep(2)

# Get all testids in ssh-files
print("=== ssh-files testids ===")
testids = eval_expr("""
(() => {
  const tree = document.querySelector('[data-testid="ssh-files"]');
  if (!tree) return [];
  return Array.from(new Set(Array.from(tree.querySelectorAll('[data-testid]')).map(e=>e.dataset.testid))).slice(0,30);
})()
""")
print(testids)

# Get first few row texts
print("\n=== ssh-files row texts ===")
texts = eval_expr("""
(() => {
  const tree = document.querySelector('[data-testid="ssh-files"]');
  if (!tree) return [];
  return Array.from(tree.querySelectorAll('[data-testid]')).slice(0,10).map(e=>e.dataset.testid + ':' + e.innerText.trim());
})()
""")
print(texts)

# Close any modal and click settings
print("\n=== click settings ===")
eval_expr("""
(() => {
  // Close any open modal by clicking overlay or pressing Escape
  const overlays = document.querySelectorAll('[data-state="open"]');
  overlays.forEach(o => { try { o.click(); } catch(e) {} });
  // Click settings button
  const btn = document.querySelector('[data-testid=\"settings-button\"]');
  if (btn) { btn.click(); return true; }
  return false;
})()
""")
time.sleep(3)

# List all CDP targets
print("\n=== CDP targets after settings click ===")
ws.close()
import requests
targets = requests.get(f"{CDP}/json/list", timeout=5).json()
for t in targets:
    print(f"  {t.get('type')}: {t.get('title')} | {t.get('url')}")
