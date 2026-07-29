"""
tools/rlm_fanout.py — RLMFanout MCP tool（T-P4-04）
=====================================================

实现 1-16 路并行子任务执行 + 结果聚合：
- 同时执行 N 个相同 prompt 的子任务（N ∈ [1, 16]）
- 3 种聚合策略：
  - voting:   多数投票（最常见的输出）
  - longest:  选择最长的输出（信息量最大）
  - highest:  选择评分最高的输出（需要 score 字段）
- mock 模式可离线运行

输入格式（params）：
    {
        "prompt": "fix nginx config",
        "n": 4,                       # 并行数 1-16，默认 4
        "strategy": "voting",         # 聚合策略，默认 "voting"
        "mock": true                  # 是否 mock 模式，默认 true
    }

输出格式：
    {
        "aggregated_output": "...",
        "strategy": "voting",
        "results": [...],             # 所有子任务结果
        "n": 4,
        "duration": 1.23
    }
"""

from __future__ import annotations

import logging
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

logger = logging.getLogger("sidecar.tools.rlm_fanout")


def invoke_rlm_fanout_tool(params: dict[str, Any]) -> dict[str, Any]:
    """RLMFanout MCP tool 入口

    Args:
        params: 工具参数，包含：
            - prompt (str, 必填): 输入提示词
            - n (int, 可选): 并行数 1-16，默认 4
            - strategy (str, 可选): 聚合策略 voting/longest/highest，默认 voting
            - mock (bool, 可选): 是否 mock 模式，默认 True

    Returns:
        聚合结果字典

    Raises:
        ValueError: 参数校验失败
    """
    # === 参数校验 ===
    prompt = params.get("prompt", "")
    if not isinstance(prompt, str):
        raise ValueError(
            f"prompt must be str, got {type(prompt).__name__}"
        )
    if not prompt:
        raise ValueError("prompt must not be empty")

    n = params.get("n", 4)
    if not isinstance(n, int) or n < 1:
        raise ValueError(f"n must be positive int, got {n}")
    # 限制 1-16
    n = max(1, min(n, 16))

    strategy = params.get("strategy", "voting")
    valid_strategies = ("voting", "longest", "highest")
    if strategy not in valid_strategies:
        raise ValueError(
            f"strategy must be one of {valid_strategies}, got '{strategy}'"
        )

    mock = params.get("mock", True)
    if not isinstance(mock, bool):
        raise ValueError(f"mock must be bool, got {type(mock).__name__}")

    # === 执行并行任务 ===
    logger.info(
        f"rlm_fanout: n={n}, strategy={strategy}, mock={mock}, "
        f"prompt_len={len(prompt)}"
    )

    start_time = time.time()
    results: list[dict[str, Any]] = []

    with ThreadPoolExecutor(max_workers=n) as executor:
        # 提交 N 个相同 prompt 的子任务
        future_to_idx = {
            executor.submit(
                _execute_subtask,
                idx=idx,
                prompt=prompt,
                mock=mock,
            ): idx
            for idx in range(n)
        }

        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                result = future.result()
                results.append(result)
            except Exception as e:
                logger.exception(f"rlm subtask {idx} failed: {e}")
                results.append({
                    "idx": idx,
                    "output": "",
                    "score": 0.0,
                    "success": False,
                    "error": str(e),
                    "duration": 0.0,
                })

    # 按 idx 排序
    results.sort(key=lambda r: r.get("idx", 0))

    # === 聚合结果 ===
    aggregated = _aggregate_results(results, strategy)

    duration = time.time() - start_time
    return {
        "aggregated_output": aggregated,
        "strategy": strategy,
        "results": results,
        "n": n,
        "succeeded": sum(1 for r in results if r.get("success")),
        "duration": round(duration, 3),
        "mock": mock,
    }


def _execute_subtask(idx: int, prompt: str, mock: bool) -> dict[str, Any]:
    """执行单个子任务

    Args:
        idx: 子任务索引（0-15）
        prompt: 输入提示词
        mock: 是否 mock 模式

    Returns:
        子任务执行结果
    """
    start_time = time.time()

    if mock:
        # mock 模式：模拟执行，返回带评分的结果
        time.sleep(0.01)  # 模拟耗时
        # 不同 idx 返回略有不同的输出（用于测试 voting/longest/highest）
        if idx % 3 == 0:
            output = f"[mock-rlm-{idx}] Strategy proposal A for: {prompt[:80]}"
            score = 0.85
        elif idx % 3 == 1:
            output = (
                f"[mock-rlm-{idx}] Strategy proposal A for: {prompt[:80]}\n"
                f"with additional context"
            )
            score = 0.78
        else:
            output = f"[mock-rlm-{idx}] Strategy proposal B for: {prompt[:80]}"
            score = 0.92

        duration = time.time() - start_time
        return {
            "idx": idx,
            "output": output,
            "score": score,
            "success": True,
            "duration": round(duration, 3),
            "mock": True,
        }

    # 真实模式：调用真实 LLM / CLI Agent
    # 占位实现（实际应调用 LLM）
    output = f"[rlm-{idx}] Real execution for: {prompt[:200]}"
    duration = time.time() - start_time
    return {
        "idx": idx,
        "output": output,
        "score": 0.8,
        "success": True,
        "duration": round(duration, 3),
        "mock": False,
    }


def _aggregate_results(
    results: list[dict[str, Any]],
    strategy: str,
) -> str:
    """聚合多个子任务结果

    Args:
        results: 子任务结果列表
        strategy: 聚合策略（voting/longest/highest）

    Returns:
        聚合后的输出字符串
    """
    successful = [r for r in results if r.get("success") and r.get("output")]
    if not successful:
        return ""

    if strategy == "voting":
        # 多数投票：选择最常见的输出
        outputs = [r["output"] for r in successful]
        counter = Counter(outputs)
        most_common = counter.most_common(1)
        if most_common:
            return most_common[0][0]
        return successful[0]["output"]

    if strategy == "longest":
        # 选择最长的输出（信息量最大）
        longest = max(successful, key=lambda r: len(r.get("output", "")))
        return longest["output"]

    if strategy == "highest":
        # 选择评分最高的输出
        scored = [r for r in successful if "score" in r]
        if scored:
            highest = max(scored, key=lambda r: r.get("score", 0))
            return highest["output"]
        # 无 score 字段时退化为 longest
        return max(successful, key=lambda r: len(r.get("output", "")))["output"]

    # 默认 fallback
    return successful[0]["output"]


def get_tool_metadata() -> dict[str, Any]:
    """获取工具元数据"""
    return {
        "name": "rlm_fanout",
        "description": (
            "RLM 并行子任务执行：1-16 路并行执行相同 prompt，"
            "支持 3 种聚合策略（voting/longest/highest）。"
            "mock 模式可离线运行。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string"},
                "n": {"type": "integer", "default": 4, "minimum": 1, "maximum": 16},
                "strategy": {
                    "type": "string",
                    "enum": ["voting", "longest", "highest"],
                    "default": "voting",
                },
                "mock": {"type": "boolean", "default": True},
            },
            "required": ["prompt"],
        },
        "output_schema": {
            "type": "object",
            "properties": {
                "aggregated_output": {"type": "string"},
                "strategy": {"type": "string"},
                "results": {"type": "array"},
                "n": {"type": "integer"},
                "duration": {"type": "number"},
            },
        },
    }
