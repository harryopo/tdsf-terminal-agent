"""Smoke test: 验证 core/log_capture.py 真的能捕获日志 + 推送到 notifier"""
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from core import log_capture  # noqa: E402

pushes = []


def notifier(name, payload):
    pushes.append({"event": name, "payload": payload})


log_capture.install_handler(rust_notifier=notifier)

# 模拟业务日志
logging.getLogger("sidecar.test").info("hello from smoke test")
logging.getLogger("sidecar.test").warning("a warning line")
logging.getLogger("sidecar.test").error("an error line")

# 通过 buffer API 直接拉取 (跳过 JSON-RPC, 直接验证底层)
buf = log_capture.get_global_buffer()
tail = buf.tail(10)
print(f"=== ringbuffer tail ({len(tail)} lines) ===")
for entry in tail:
    level = entry["level"]
    logger_name = entry["logger"]
    msg = entry["msg"]
    print(f"  [{level}] {logger_name}: {msg}")

print()
print(f"=== stats: {buf.stats()} ===")
print()
print(f"=== rust_notifier 实时推送 ({len(pushes)} 次) ===")
for p in pushes[-3:]:
    event = p["event"]
    level = p["payload"]["level"]
    msg = p["payload"]["msg"][:60]
    print(f"  event={event} level={level} msg={msg}")

# 测试 level filter
filtered = buf.tail(10, level_filter="ERROR")
print()
print(f"=== level filter ERROR ({len(filtered)} lines) ===")
for entry in filtered:
    print(f"  [{entry['level']}] {entry['msg'][:60]}")

# 测试 clear
cleared = buf.clear()
print()
print(f"=== clear: {cleared} lines cleared ===")
print(f"=== stats after clear: {buf.stats()} ===")
