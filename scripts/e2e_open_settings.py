import json
import time

import requests
import websocket

CDP = "http://localhost:9222"


def click_settings():
    targets = requests.get(f"{CDP}/json/list", timeout=5).json()
    page = [t for t in targets if t.get("type") == "page"][0]
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=15)
    ws.send(
        json.dumps(
            {
                "id": 1,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": 'document.querySelector("[data-testid=\\"settings-button\\"]").click()',
                    "returnByValue": True,
                },
            }
        )
    )
    time.sleep(0.5)
    ws.close()
    print("clicked settings")


def list_targets():
    targets = requests.get(f"{CDP}/json/list", timeout=5).json()
    print("CDP targets:")
    for t in targets:
        print(f"  {t.get('type')}: {t.get('title')} | {t.get('url')}")


if __name__ == "__main__":
    click_settings()
    time.sleep(3)
    list_targets()
