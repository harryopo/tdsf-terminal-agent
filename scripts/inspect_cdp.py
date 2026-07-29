import json
import requests
import websocket

CDP = "http://localhost:9222"
targets = requests.get(f"{CDP}/json/list", timeout=5).json()
pages = [t for t in targets if t.get("type") == "page"]
page = pages[0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=15)


def eval_expr(expression: str):
    msg_id = [0]
    msg_id[0] += 1
    ws.send(json.dumps({"id": msg_id[0], "method": "Runtime.enable"}))
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == msg_id[0]:
            break
    msg_id[0] += 1
    ws.send(
        json.dumps(
            {
                "id": msg_id[0],
                "method": "Runtime.evaluate",
                "params": {
                    "expression": expression,
                    "returnByValue": True,
                    "awaitPromise": True,
                },
            }
        )
    )
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == msg_id[0]:
            return r


testids = eval_expr(
    "Array.from(document.querySelectorAll('[data-testid]')).map(e=>e.getAttribute('data-testid'))"
)
print("testids:", testids["result"]["result"].get("value"))

body_text = eval_expr("document.body.innerText.slice(0,800)")
print("body text:", body_text["result"]["result"].get("value"))

buttons = eval_expr(
    "Array.from(document.querySelectorAll('button')).map(b=>b.innerText.trim()).filter(Boolean)"
)
print("buttons:", buttons["result"]["result"].get("value"))

ws.close()
