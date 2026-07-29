"""端到端验证: DeepSeek API + LLM 调用链路 + Agent 集成 (v3 - 显式路径)"""
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

# 强制设置工作目录为项目根
os.chdir(r"d:\ai\linux教学一体\tdsf-terminal-agent-clone")
os.environ["TDSF_DATA_DIR"] = ".tdsf-data"

# 1. 直接测试 DeepSeek API
print("=" * 60)
print("Step 1: 直接调用 DeepSeek API (HTTP 层验证)")
print("=" * 60)
cfg_path = Path(".tdsf-data/llm_config.json")
print(f"  cfg_path exists: {cfg_path.exists()}")
print(f"  cwd: {os.getcwd()}")
cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
print(f"  provider={cfg['provider']}, model={cfg['model']}")
print(f"  base_url={cfg['base_url']}")

req_body = {
    "model": cfg["model"],
    "messages": [
        {"role": "system", "content": "You are a Linux system administrator. Answer concisely."},
        {"role": "user", "content": "用一句话说明什么是 SELinux"},
    ],
    "temperature": cfg.get("temperature", 0.7),
    "max_tokens": cfg.get("max_tokens", 256),
}
req = urllib.request.Request(
    f"{cfg['base_url']}/chat/completions",
    data=json.dumps(req_body).encode("utf-8"),
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {cfg['api_key']}",
    },
    method="POST",
)
api_ok = False
try:
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {})
        print(f"  HTTP 200 OK")
        print(f"  model={data.get('model')}")
        print(f"  tokens: prompt={usage.get('prompt_tokens')}, completion={usage.get('completion_tokens')}")
        print(f"  response: {content[:200]}")
        api_ok = True
except urllib.error.HTTPError as e:
    body = e.read().decode("utf-8", errors="replace")
    print(f"  HTTP {e.code}: {body[:200]}")
except Exception as e:
    print(f"  ERROR: {e}")

# 2. 测试 core.llm_config.make_llm_call
print()
print("=" * 60)
print("Step 2: 加载配置 + make_llm_call")
print("=" * 60)
factory_ok = False
try:
    sys.path.insert(0, "src-tauri/sidecar")
    from core.llm_config import load_config, make_llm_call

    cfg_loaded = load_config()
    print(f"  loaded provider={cfg_loaded.provider}, model={cfg_loaded.model}, is_configured={cfg_loaded.is_configured}")
    print(f"  base_url={cfg_loaded.base_url}")
    llm_call = make_llm_call(cfg_loaded)
    print(f"  llm_call callable: {callable(llm_call)}")
    if llm_call is not None:
        response = llm_call([
            {"role": "user", "content": "用一句话说明 SELinux 是什么"},
        ])
        print(f"  LLM response[:200]={str(response)[:200]}")
        factory_ok = True
    else:
        print("  llm_call is None, LLM 未配置")
except Exception as e:
    import traceback
    traceback.print_exc()

# 3. 测试 BaseAgent 集成
print()
print("=" * 60)
print("Step 3: BaseAgent 集成真实 LLM")
print("=" * 60)
base_agent_ok = False
try:
    from agents.base import BaseAgent
    from core.llm_config import load_config, make_llm_call

    cfg_loaded = load_config()
    llm_call = make_llm_call(cfg_loaded)
    agent = BaseAgent(
        name="test-coding",
        role="coding assistant",
        description="Test coding agent",
        tools=["bash"],
        event_bus=None,
        llm_call=llm_call,
    )
    print(f"  agent.llm_call is None: {agent.llm_call is None}")

    # 实际 LLM 调用
    response = agent.call_llm([
        {"role": "system", "content": "You are a concise Linux expert."},
        {"role": "user", "content": "列出 3 个最常用的 Linux 性能监控命令, 用中文"},
    ])
    print(f"  call_llm response[:300]={str(response)[:300]}")
    if "[mock" in str(response).lower():
        print(f"  ⚠️ WARNING: response is mock, BaseAgent 未真正调用 LLM")
    else:
        base_agent_ok = True
except Exception as e:
    import traceback
    traceback.print_exc()

# 4. 总结
print()
print("=" * 60)
print("END-TO-END SUMMARY")
print("=" * 60)
print(f"  DeepSeek API (HTTP):       {'✓ OK' if api_ok else '✗ FAIL'}")
print(f"  core.llm_config.make_llm_call: {'✓ OK' if factory_ok else '✗ FAIL'}")
print(f"  BaseAgent 集成真实 LLM:    {'✓ OK' if base_agent_ok else '✗ FAIL'}")
print()
if api_ok and factory_ok and base_agent_ok:
    print("  ALL GREEN ✓ - LLM 链路完整, Agent 不再返回 [mock:coding]")
    sys.exit(0)
else:
    print("  SOME FAIL ✗ - 需要检查 LLM 链路")
    sys.exit(1)
