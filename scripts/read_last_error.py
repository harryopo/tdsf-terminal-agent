import json
import requests
import websocket
import time

CDP = "http://localhost:9222"
targets = requests.get(f"{CDP}/json/list", timeout=5).json()
page = [t for t in targets if t.get("type") == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=15)


def send(method, params=None, _id=[0]):
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
print("Wait 4s for HMR...")
time.sleep(4)

# click SSH tab
print("Click SSH tab")
eval_expr("""
(()=>{
  const btns = Array.from(document.querySelectorAll('button'));
  const b = btns.find(x => x.innerText.trim() === 'SSH');
  if (b) { b.click(); return true; }
  return false;
})()
""")
time.sleep(2)

err = eval_expr("window.__lastBoundaryError__")
print("last error:", err)
ws.close()
