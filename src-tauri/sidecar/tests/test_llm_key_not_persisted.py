"""
tests/test_llm_key_not_persisted.py — API Key 不再明文落盘（#158-①）
=====================================================================

背景：OS keyring 里已经有一份 key，而 `save_config` 又把它**明文镜像**进
`.tdsf-data/llm_config.json`。#153 把这个文件名挡进了 .gitignore（约定不是机制），
真正的外泄面是"任何读本机文件的的东西"（恶意软件、备份同步、日志采集）。
"内容已被打了码"不等于"用户同意过你把 key 写到磁盘上"。

改法（读侧只有一个主人，所以只动这一个模块 + 一处启动迁移）：
- 写：`save_config` 不再落 `api_key`，其余字段照落（重启仍认得是哪个模型）；
- 读：优先级 **env → 进程内运行时缓存 → 文件（不含 key）→ 空**；
- 迁移：`strip_stored_secret()` 一次性把存量文件里的 key 抹掉，**先留 .bak-<ts>**；
- 韧性变化（这是有意的）：同步失败时不再"沿用磁盘上的旧 key 继续跑"，
  而是 `is_configured=False` → agent 明确没模型，界面 `llm_configured` 看得见。

判据两头都要钉：既要"key 不落盘"，也要"模型身份照常恢复"与"env 仍然是第一优先"
—— 只测前者的话，"把整个文件读写删掉"也能让第一组全绿。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.llm_config import (  # noqa: E402
    LLMConfig,
    load_config,
    save_config,
    set_runtime_config,
    strip_stored_secret,
)

# 测试用假 key：**拼出来**，绝不写连续的可信凭据字面量（GitHub 密钥扫描会当真）。
FAKE_KEY = "sk-te" + "st-1234567890abcdef"


class _ConfigFileCase(unittest.TestCase):
    """公共底座：TDSF_DATA_DIR 指到临时目录 + 清掉 env/运行时缓存污染"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._prev_data_dir = os.environ.get("TDSF_DATA_DIR")
        os.environ["TDSF_DATA_DIR"] = self._tmp.name
        self._prev_env = {
            k: os.environ.get(k)
            for k in (
                "TDSF_LLM_API_KEY",
                "TDSF_LLM_BASE_URL",
                "TDSF_LLM_MODEL",
                "TDSF_LLM_PROVIDER",
            )
        }
        for k in self._prev_env:
            os.environ.pop(k, None)
        set_runtime_config(None)

    def tearDown(self) -> None:
        set_runtime_config(None)
        for k, v in self._prev_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        if self._prev_data_dir is None:
            os.environ.pop("TDSF_DATA_DIR", None)
        else:
            os.environ["TDSF_DATA_DIR"] = self._prev_data_dir
        self._tmp.cleanup()

    def _file(self) -> Path:
        return Path(self._tmp.name) / "llm_config.json"

    def _read(self) -> dict:
        return json.loads(self._file().read_text(encoding="utf-8"))


class TestKeyNotPersisted(_ConfigFileCase):
    def test_save_config_does_not_write_api_key(self):
        save_config(
            LLMConfig(
                provider="deepseek",
                api_key=FAKE_KEY,
                base_url="https://api.deepseek.com/v1",
                model="deepseek-chat",
            )
        )
        disk = self._file().read_text(encoding="utf-8")
        self.assertNotIn(FAKE_KEY, disk, "key 仍在磁盘上 = 这条判据没看住")
        self.assertNotIn("sk-test", disk)
        data = json.loads(disk)
        self.assertFalse(data.get("api_key"), f"落盘的 api_key 必须是空：{data.get('api_key')!r}")

    def test_non_secret_fields_still_round_trip(self):
        """正向配对：省掉的是 key，不是整份配置 —— 重启仍要认得是哪个模型/端点"""
        save_config(
            LLMConfig(
                provider="deepseek",
                api_key=FAKE_KEY,
                base_url="https://api.deepseek.com/v1",
                model="deepseek-chat",
                temperature=0.3,
                max_tokens=4096,
            )
        )
        data = self._read()
        self.assertEqual(data["provider"], "deepseek")
        self.assertEqual(data["model"], "deepseek-chat")
        self.assertEqual(data["base_url"], "https://api.deepseek.com/v1")
        self.assertEqual(data["temperature"], 0.3)
        self.assertEqual(data["max_tokens"], 4096)

    def test_saved_file_never_reopens_a_key_from_disk(self):
        """即便有人手工把 key 塞回文件，load_config 也不认它（读侧不认磁盘上的 key）"""
        save_config(LLMConfig(provider="openai", api_key=FAKE_KEY, model="gpt-4o-mini"))
        data = self._read()
        data["api_key"] = FAKE_KEY  # 手改落盘文件，模拟存量/篡改
        self._file().write_text(json.dumps(data), encoding="utf-8")
        set_runtime_config(None)
        self.assertFalse(load_config().is_configured, "文件里的 key 不该再被采信")


class TestRuntimeCacheAndPrecedence(_ConfigFileCase):
    def test_runtime_cache_serves_key_without_disk(self):
        save_config(LLMConfig(provider="qwen", api_key=FAKE_KEY, model="qwen-plus"))
        set_runtime_config(
            LLMConfig(provider="qwen", api_key=FAKE_KEY, model="qwen-plus")
        )
        cfg = load_config()
        self.assertTrue(cfg.is_configured, "运行时缓存要能供 key（不落盘的代价就是它）")
        self.assertEqual(cfg.api_key, FAKE_KEY)
        self.assertEqual(cfg.model, "qwen-plus")

    def test_env_beats_runtime_cache(self):
        set_runtime_config(LLMConfig(provider="qwen", api_key=FAKE_KEY, model="qwen-plus"))
        os.environ["TDSF_LLM_API_KEY"] = "other-" + "key-999"
        os.environ["TDSF_LLM_MODEL"] = "env-model"
        cfg = load_config()
        self.assertEqual(cfg.model, "env-model", "env 仍是第一优先（离线脚本靠它）")
        self.assertEqual(cfg.api_key, "other-key-999")

    def test_nothing_configured_is_explicit_not_silent(self):
        cfg = load_config()
        self.assertFalse(cfg.is_configured)
        self.assertEqual(cfg.provider, "openai")  # 空配置也要给出可用对象，别抛


class TestStoredSecretMigration(_ConfigFileCase):
    def _write_legacy(self) -> None:
        self._file().write_text(
            json.dumps(
                {
                    "provider": "deepseek",
                    "api_key": FAKE_KEY,
                    "base_url": "https://api.deepseek.com/v1",
                    "model": "deepseek-chat",
                    "temperature": 0.7,
                    "max_tokens": 8192,
                }
            ),
            encoding="utf-8",
        )

    def test_strip_removes_key_but_keeps_identity(self):
        self._write_legacy()
        changed = strip_stored_secret()
        self.assertTrue(changed)
        data = self._read()
        self.assertFalse(data.get("api_key"))
        self.assertEqual(data["model"], "deepseek-chat")
        self.assertEqual(data["provider"], "deepseek")

    def test_strip_backs_up_before_rewriting(self):
        """动用户机器上的数据文件必须留后路 —— 直接改写等于删他的配置"""
        self._write_legacy()
        strip_stored_secret()
        backups = list(Path(self._tmp.name).glob("llm_config.json.bak-*"))
        self.assertEqual(len(backups), 1, f"应留下恰好一份备份，实际 {[b.name for b in backups]}")
        self.assertIn(FAKE_KEY, backups[0].read_text(encoding="utf-8"))

    def test_clean_file_is_left_alone(self):
        """正向配对的反面：已干净就别写、别造备份 —— 每次启动都动他文件是新的故障"""
        save_config(LLMConfig(provider="deepseek", api_key=FAKE_KEY, model="deepseek-chat"))
        before = self._file().read_text(encoding="utf-8")
        self.assertFalse(strip_stored_secret())
        self.assertEqual(self._file().read_text(encoding="utf-8"), before)
        self.assertEqual(list(Path(self._tmp.name).glob("llm_config.json.bak-*")), [])

    def test_missing_file_is_not_created(self):
        self.assertFalse(strip_stored_secret())
        self.assertFalse(self._file().exists())


class TestWiring(_ConfigFileCase):
    def test_configure_sets_runtime_cache_and_persists_identity(self):
        """agent_facade.configure 是 key 的唯一入口：它必须**同时**喂内存缓存并持久化身份。

        只落盘不缓存 = 重启后没 key；只缓存不落盘 = 每次重启都要重新同步模型身份。
        两个都少一半，所以两个都要在。取真实调用节点而不是 `src.index()` ——
        后者会命中 import 行里的同名文字（#158-③ 那条教训在这轮又复发了一次）。
        """
        import ast
        import inspect

        import agent_facade

        tree = ast.parse(inspect.getsource(agent_facade.configure))
        called = {
            node.func.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        self.assertIn("set_runtime_config", called, "configure 没登记运行时缓存 → 不落盘就等于 agent 没模型")
        self.assertIn("save_config", called, "configure 不再持久化模型身份 → 重启后还要人重配一遍")

        lines = {
            node.func.id: node.lineno
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id in {"set_runtime_config", "create_strands_model"}
        }
        self.assertLess(
            lines["set_runtime_config"],
            lines["create_strands_model"],
            "缓存必须先登记：create_strands_model / 后续任何 load_config() 都靠它拿 key",
        )

    def test_boot_strips_stored_secret_before_loading(self):
        """启动顺序：先抹存量再 load_config，否则本次启动仍会用明文 key 建模型。"""
        import ast

        boot = Path(__file__).parent.parent / "main.py"
        text = boot.read_text(encoding="utf-8")
        # 用 AST 定位真实调用行，不接受注释/文档字符串里的同名文字（#158-③ 的教训）
        import ast

        lines = text.splitlines()
        call_lines = {
            node.lineno
            for node in ast.walk(ast.parse(text))
            if isinstance(node, ast.Call)
            and getattr(getattr(node, "func", None), "id", "") == "strip_stored_secret"
        }
        load_lines = {
            node.lineno
            for node in ast.walk(ast.parse(text))
            if isinstance(node, ast.Call)
            and getattr(getattr(node, "func", None), "id", "") == "load_config"
        }
        self.assertTrue(call_lines, "main.py 必须在启动时调用 strip_stored_secret()")
        self.assertTrue(load_lines, "main.py 启动时要 load_config()（这条是判据自身的锚点）")
        self.assertLess(min(call_lines), min(load_lines), "抹存量必须排在读取之前")
        self.assertTrue(any("strip_stored_secret" in ln for ln in lines))


if __name__ == "__main__":
    unittest.main()
