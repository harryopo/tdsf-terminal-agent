"""P4 独立计分：精确文本匹配，不做命令规范化。"""

from __future__ import annotations

TOP_K = 5


def score_next(predictions: list[str], gold: str) -> dict:
    """对单个 query 计分；命中位置未出现即未命中，RR@5 取 0。"""
    if not isinstance(predictions, list):
        raise ValueError("predictions 必须是 list")
    if not isinstance(gold, str) or not gold:
        raise ValueError("gold 必须是非空字符串")
    if len(predictions) > TOP_K:
        raise ValueError(f"predictions 最多 {TOP_K} 条")
    for item in predictions:
        if not isinstance(item, str) or not item:
            raise ValueError("predictions 每项必须是非空字符串")
    if len(set(predictions)) != len(predictions):
        raise ValueError("predictions 不得包含重复命令")

    rank = predictions.index(gold) + 1 if gold in predictions else None
    return {
        "rank": rank,
        "hit1": rank == 1,
        "hit3": rank is not None and rank <= 3,
        "hit5": rank is not None and rank <= 5,
        "rr5": (1.0 / rank) if rank is not None else 0.0,
        "nonEmpty": bool(predictions),
    }


def aggregate_scores(scores: list[dict]) -> dict:
    """汇总同一批全部 query 的均值；空结果不剔除分母。"""
    n = len(scores)
    if n == 0:
        return {"n": 0, "hit1": None, "hit3": None, "hit5": None, "rr5": None, "nonEmpty": None}
    return {
        "n": n,
        "hit1": sum(1 for s in scores if s["hit1"]) / n,
        "hit3": sum(1 for s in scores if s["hit3"]) / n,
        "hit5": sum(1 for s in scores if s["hit5"]) / n,
        "rr5": sum(s["rr5"] for s in scores) / n,
        "nonEmpty": sum(1 for s in scores if s["nonEmpty"]) / n,
    }
