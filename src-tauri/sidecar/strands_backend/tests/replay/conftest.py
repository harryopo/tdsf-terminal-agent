"""T8 回放测试夹具（spec 8.3：pytest mark replay，CI 可跑）

隔离三件事：
1. TDSF_DATA_DIR → tmp_path（agent_log 流水落盘不进仓库）
2. agent_log / todo 镜像 重置（场景间互不污染）
3. 审批门控自动放行：真实 request_approval_and_wait 会阻塞等人工点击，
   回放必须在无人值守下跑完——沿用 tests/test_tools.py 的 patch 口径。
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

_SIDECAR_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _SIDECAR_DIR not in sys.path:
    sys.path.insert(0, _SIDECAR_DIR)


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "replay: T8 会话回放测试（读场景 JSONL 重放闭环行为）")


@pytest.fixture(autouse=True)
def _replay_env(tmp_path, monkeypatch):
    from needs_you import NeedsYouStatus
    from strands_backend.agent_log import reset_for_test
    from strands_backend.tools.todo_write import reset_session_todos

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    reset_for_test()
    reset_session_todos()
    with patch(
        "strands_backend.tools.request_approval_and_wait",
        return_value=MagicMock(status=NeedsYouStatus.APPROVED),
    ):
        yield
    reset_for_test()
    reset_session_todos()
