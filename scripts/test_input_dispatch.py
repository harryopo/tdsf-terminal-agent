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

def recv(req_id, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        ws.settimeout(max(0.1, deadline - time.time()))
        try:
            raw = ws.recv()
        except websocket.WebSocketTimeoutException:
            continue
        data = json.loads(raw)
        if data.get("id") == req_id:
            return data
    return None

def eval_expr(expr):
    req = send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    return recv(req)

send("Runtime.enable")
send("Input.enable")
time.sleep(1)

# Click SSH tab to ensure terminal visible
eval_expr("""
(()=>{
  const btns = Array.from(document.querySelectorAll('button'));
  const b = btns.find(x => x.innerText.trim() === 'SSH');
  if (b) b.click();
  return true;
})()
""")
time.sleep(2)

# Focus terminal
eval_expr("document.querySelector('.xterm-helper-textarea')?.focus()")
time.sleep(0.5)

# Dispatch keys via CDP Input domain
def dispatch_key(key, code):
    send("Input.dispatchKeyEvent", {"type": "keyDown", "key": key, "code": code, "text": key if len(key) == 1 else ""})
    time.sleep(0.05)
    send("Input.dispatchKeyEvent", {"type": "keyUp", "key": key, "code": code})
    time.sleep(0.05)

for ch in "whoami":
    dispatch_key(ch, f"Key{ch.upper()}")

time.sleep(0.5)
dispatch_key("Enter", "Enter")
time.sleep(2)

# Read buffer via xterm API - try to find terminal instance
result = eval_expr("""
(() => {
  // Try to find terminal instance from DOM
  const textarea = document.querySelector('.xterm-helper-textarea');
  if (!textarea) return 'no textarea';
  // Look for any property on window that has buffer
  for (const k of Object.keys(window)) {
    try {
      const v = window[k];
      if (v && typeof v === 'object' && v.buffer && v.buffer.active) {
        const buf = v.buffer.active;
        let lines = [];
        for (let i = 0; i < buf.length; i++) {
          lines.push(buf.getLine(i).translateToString(true));
        }
        return {key: k, text: lines.join('\\n').slice(-300)};
      }
    } catch(e) {}
  }
  return 'no terminal instance found';
})()
""")
print(json.dumps(result, indent=2, ensure_ascii=False)[:2000])

ws.close()
