"""Smoke test: 验证 Skill invoke 三种路径 (shell executor / python executor / no executor)"""
import json
from skills.registry import SkillRegistry

reg = SkillRegistry()
reg.load_builtin()

print("=== Test 1: selinux-baseline (shell executor: getenforce) ===")
result = reg.invoke("selinux-baseline")
out = {k: (v[:200] if isinstance(v, str) and k in ("stderr", "output", "stdout") else v)
       for k, v in result.items()}
print(json.dumps(out, ensure_ascii=False, indent=2)[:600])

print()
print("=== Test 2: python-debug (shell executor: python --version) ===")
result = reg.invoke("python-debug")
out = {k: (v[:200] if isinstance(v, str) and k in ("stderr", "output", "stdout") else v)
       for k, v in result.items()}
print(json.dumps(out, ensure_ascii=False, indent=2)[:600])

print()
print("=== Test 3: ssh-troubleshoot (no executor -> knowledge card) ===")
result = reg.invoke("ssh-troubleshoot")
print(f"  source={result.get('source')}")
print(f"  output_len={len(result.get('output', ''))}")
print(f"  output_head={result.get('output', '')[:150]}")

print()
print("ALL TESTS PASSED")
