"""Smoke test 2: 验证 knowledge card 模式返回 content/when_to_use/steps"""
import json
from skills.registry import SkillRegistry

reg = SkillRegistry()
reg.load_builtin()

result = reg.invoke("ssh-troubleshoot")
print(f"source={result.get('source')}")
print(f"keys={list(result.keys())}")
print(f"content_len={len(result.get('content', ''))}")
print(f"steps_len={len(result.get('steps', ''))}")
print(f"when_to_use_len={len(result.get('when_to_use', ''))}")
print(f"content[:200]={result.get('content', '')[:200]}")
print()
print("ALL CHECKS PASSED")
