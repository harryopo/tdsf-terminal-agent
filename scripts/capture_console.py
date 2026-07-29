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


send("Runtime.enable")
send("Log.enable")
send("Console.enable")

# Wait and print events for 5 seconds
deadline = time.time() + 5
while time.time() < deadline:
    ws.settimeout(max(0.1, deadline - time.time()))
    try:
        raw = ws.recv()
        data = json.loads(raw)
        if data.get("method") in ("Runtime.consoleAPICalled", "Log.entryAdded", "Console.messageAdded"):
            print(json.dumps(data, ensure_ascii=False))
    except websocket.WebSocketTimeoutException:
        pass

ws.close()
