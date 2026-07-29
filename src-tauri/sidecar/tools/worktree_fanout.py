"""
tools/worktree_fanout.py — WorktreeFanout MCP tool（T-P4-03）
==============================================================

实现 git worktree 并行任务执行：
- 在独立 git worktree 中并行执行多个子任务
- 使用 ThreadPoolExecutor 控制 max_parallel
- mock 模式可离线运行（不依赖真实 git 命令）

输入格式（params）：
    {
        "tasks": [
            {"id": "t1", "prompt": "fix bug A"},
            {"id": "t2", "prompt": "fix bug B"},
        ],
        "repo_path": "/path/to/repo",
        "max_parallel": 4,        # 可选，默认 4
        "branch_prefix": "fanout",  # 可选，默认 "fanout"
        "mock": true                # 可选，默认 true（离线测试）
    }

输出格式：
    {
        "results": [
            {
                "id": "t1",
                "worktree": "/tmp/worktree-t1",
                "branch": "fanout-t1",
                "output": "...",
                "success": true,
                "duration": 1.23
            }
        ],
        "total": 2,
        "succeeded": 2,
        "failed": 0,
        "duration": 1.45
    }
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable

logger = logging.getLogger("sidecar.tools.worktree_fanout")


# ============================================================================
# 模块级单例（无状态，仅用于工具元数据）
# ============================================================================


def invoke_worktree_fanout_tool(params: dict[str, Any]) -> dict[str, Any]:
    """WorktreeFanout MCP tool 入口

    Args:
        params: 工具参数，包含：
            - tasks (list, 必填): 子任务列表 [{id, prompt}, ...]
            - repo_path (str, 可选): 仓库路径（mock 模式下不使用）
            - max_parallel (int, 可选): 最大并行度，默认 4
            - branch_prefix (str, 可选): 分支前缀，默认 "fanout"
            - mock (bool, 可选): 是否 mock 模式，默认 True

    Returns:
        并行执行结果字典

    Raises:
        ValueError: 参数校验失败
    """
    # === 参数校验 ===
    tasks = params.get("tasks", [])
    if not isinstance(tasks, list):
        raise ValueError(
            f"tasks must be list, got {type(tasks).__name__}"
        )
    if not tasks:
        raise ValueError("tasks must not be empty")

    # 校验每个 task
    for i, task in enumerate(tasks):
        if not isinstance(task, dict):
            raise ValueError(
                f"tasks[{i}] must be dict, got {type(task).__name__}"
            )
        if "id" not in task or "prompt" not in task:
            raise ValueError(
                f"tasks[{i}] must have 'id' and 'prompt' fields"
            )

    repo_path = params.get("repo_path", "")
    max_parallel = params.get("max_parallel", 4)
    if not isinstance(max_parallel, int) or max_parallel < 1:
        raise ValueError(
            f"max_parallel must be positive int, got {max_parallel}"
        )
    # 限制最大并行度 16
    max_parallel = min(max_parallel, 16)

    branch_prefix = params.get("branch_prefix", "fanout")
    if not isinstance(branch_prefix, str) or not branch_prefix:
        raise ValueError("branch_prefix must be non-empty str")

    mock = params.get("mock", True)
    if not isinstance(mock, bool):
        raise ValueError(f"mock must be bool, got {type(mock).__name__}")

    # === 执行并行任务 ===
    logger.info(
        f"worktree_fanout: {len(tasks)} tasks, "
        f"max_parallel={max_parallel}, mock={mock}"
    )

    start_time = time.time()
    results: list[dict[str, Any]] = []

    with ThreadPoolExecutor(max_workers=max_parallel) as executor:
        # 提交所有任务
        future_to_task = {
            executor.submit(
                _execute_in_worktree,
                task=task,
                repo_path=repo_path,
                branch_prefix=branch_prefix,
                mock=mock,
            ): task
            for task in tasks
        }

        # 按完成顺序收集结果
        for future in as_completed(future_to_task):
            task = future_to_task[future]
            try:
                result = future.result()
                results.append(result)
            except Exception as e:
                logger.exception(
                    f"worktree task '{task.get('id')}' failed: {e}"
                )
                results.append({
                    "id": task.get("id", "?"),
                    "worktree": "",
                    "branch": "",
                    "output": "",
                    "success": False,
                    "error": str(e),
                    "duration": 0.0,
                })

    # 按 id 排序结果（保持输入顺序）
    task_id_order = {t["id"]: i for i, t in enumerate(tasks)}
    results.sort(key=lambda r: task_id_order.get(r["id"], 0))

    total_duration = time.time() - start_time
    succeeded = sum(1 for r in results if r.get("success"))
    failed = len(results) - succeeded

    return {
        "results": results,
        "total": len(results),
        "succeeded": succeeded,
        "failed": failed,
        "duration": round(total_duration, 3),
        "mock": mock,
    }


def _execute_in_worktree(
    task: dict[str, Any],
    repo_path: str,
    branch_prefix: str,
    mock: bool,
) -> dict[str, Any]:
    """在独立 worktree 中执行单个任务

    Args:
        task: 子任务 {id, prompt}
        repo_path: 仓库路径
        branch_prefix: 分支前缀
        mock: 是否 mock 模式

    Returns:
        单任务执行结果
    """
    task_id = task["id"]
    prompt = task["prompt"]
    branch = f"{branch_prefix}-{task_id}"
    start_time = time.time()

    if mock:
        # mock 模式：不创建真实 worktree，模拟执行
        worktree_path = tempfile.gettempdir() + f"/mock-worktree-{task_id}"
        output = _mock_execute_task(task_id, prompt)
        duration = time.time() - start_time
        return {
            "id": task_id,
            "worktree": worktree_path,
            "branch": branch,
            "output": output,
            "success": True,
            "duration": round(duration, 3),
            "mock": True,
        }

    # 真实模式：创建 git worktree 并执行
    worktree_path = tempfile.mkdtemp(prefix=f"worktree-{task_id}-")
    try:
        # git worktree add <path> -b <branch>
        result = subprocess.run(
            ["git", "worktree", "add", worktree_path, "-b", branch],
            capture_output=True,
            text=True,
            cwd=repo_path or None,
            timeout=30,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"git worktree add failed: {result.stderr.strip()}"
            )

        # 在 worktree 中执行任务（这里仅返回 prompt 作为占位）
        # 实际场景下应调用 LLM 或外部 CLI Agent
        output = f"[worktree:{branch}] Executed: {prompt[:200]}"

        duration = time.time() - start_time
        return {
            "id": task_id,
            "worktree": worktree_path,
            "branch": branch,
            "output": output,
            "success": True,
            "duration": round(duration, 3),
            "mock": False,
        }
    except Exception as e:
        duration = time.time() - start_time
        return {
            "id": task_id,
            "worktree": worktree_path,
            "branch": branch,
            "output": "",
            "success": False,
            "error": str(e),
            "duration": round(duration, 3),
            "mock": False,
        }


def _mock_execute_task(task_id: str, prompt: str) -> str:
    """mock 模式下模拟任务执行（不调用真实 git / LLM）"""
    time.sleep(0.01)  # 模拟执行耗时
    return (
        f"[mock-worktree] task={task_id}, "
        f"prompt={prompt[:100]}{'...' if len(prompt) > 100 else ''}\n"
        f"→ Simulated execution completed."
    )


def get_tool_metadata() -> dict[str, Any]:
    """获取工具元数据"""
    return {
        "name": "worktree_fanout",
        "description": (
            "Git worktree 并行任务执行：在独立 worktree 中并行执行多个子任务，"
            "支持 max_parallel 控制并行度。mock 模式可离线运行。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "description": "子任务列表 [{id, prompt}, ...]",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "prompt": {"type": "string"},
                        },
                    },
                },
                "repo_path": {"type": "string"},
                "max_parallel": {"type": "integer", "default": 4},
                "branch_prefix": {"type": "string", "default": "fanout"},
                "mock": {"type": "boolean", "default": True},
            },
            "required": ["tasks"],
        },
        "output_schema": {
            "type": "object",
            "properties": {
                "results": {"type": "array"},
                "total": {"type": "integer"},
                "succeeded": {"type": "integer"},
                "failed": {"type": "integer"},
                "duration": {"type": "number"},
            },
        },
    }
