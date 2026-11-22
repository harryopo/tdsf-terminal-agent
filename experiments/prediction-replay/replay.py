"""P4 时间滚动回放：逐 query 只用严格早于该请求时间的历史，输出可复现 digest。"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import baselines
import metrics


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest_of(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def cases_sha256(cases: object) -> str:
    return digest_of(cases)


def load_cases(path: str | Path) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        raise ValueError("cases.json 顶层 schemaVersion 必须为 1")
    for key in ("events", "queries"):
        if not isinstance(data.get(key), list):
            raise ValueError(f"cases.json 缺少 {key} 列表")
    return data


def replay(events: list[dict], queries: list[dict], kind: str) -> dict:
    """对同一批 query 回放单一基线；分母为全部 query，空结果 RR=0。"""
    if kind not in baselines.KINDS:
        raise ValueError(f"kind 必须是 {baselines.KINDS} 之一")

    all_events = baselines.validate_events(events)
    if not isinstance(queries, list):
        raise ValueError("queries 必须是 list")

    per_query: list[dict] = []
    seen_ids: set[str] = set()
    for query in queries:
        normalized = baselines.validate_query(query, require_gold=True)
        query_id = normalized["queryId"]
        if query_id in seen_ids:
            raise ValueError(f"重复 queryId: {query_id}")
        seen_ids.add(query_id)

        # 逐 query 切片：仅保留严格早于该请求时间的事件，杜绝未来泄漏。
        history = [e for e in all_events if e["tMs"] < normalized["tMs"]]
        query_without_gold = {k: v for k, v in normalized.items() if k != "gold"}
        predictions = baselines.predict(kind, history, query_without_gold)
        score = metrics.score_next(predictions, normalized["gold"])
        cold = baselines.is_cold_start(history, normalized["namespaceId"])
        per_query.append(
            {
                "queryId": query_id,
                "namespaceId": normalized["namespaceId"],
                "epoch": normalized["epoch"],
                "tMs": normalized["tMs"],
                "gold": normalized["gold"],
                "predictions": predictions,
                "coldStart": cold,
                "metrics": score,
            }
        )

    all_scores = [item["metrics"] for item in per_query]
    cold_items = [item for item in per_query if item["coldStart"]]
    report = {
        "schemaVersion": 1,
        "baselineVersion": baselines.BASELINE_VERSION,
        "kind": kind,
        "n": len(per_query),
        "summary": metrics.aggregate_scores(all_scores),
        "coldStart": {
            "n": len(cold_items),
            "queryIds": [item["queryId"] for item in cold_items],
            "metrics": metrics.aggregate_scores([item["metrics"] for item in cold_items]),
        },
        "perQuery": per_query,
    }
    report["digest"] = digest_of(report)
    return report


def replay_all(cases: dict) -> dict:
    """同批 query 依次跑四个固定基线，返回可复现的整包报告。"""
    reports = {
        kind: replay(cases["events"], cases["queries"], kind) for kind in baselines.KINDS
    }
    bundle = {
        "schemaVersion": 1,
        "baselineVersion": baselines.BASELINE_VERSION,
        "casesSha256": cases_sha256(cases),
        "n": len(cases["queries"]),
        "baselines": reports,
    }
    bundle["digest"] = digest_of(bundle)
    return bundle


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="P4 下一命令离线回放（合成夹具）")
    parser.add_argument("--cases", default=str(Path(__file__).with_name("cases.json")))
    parser.add_argument("--kind", choices=baselines.KINDS, default=None)
    parser.add_argument("--json", action="store_true", help="输出完整 JSON 报告")
    args = parser.parse_args(argv)

    cases = load_cases(args.cases)
    if args.kind:
        report: dict = replay(cases["events"], cases["queries"], args.kind)
    else:
        report = replay_all(cases)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        if args.kind:
            summary_line = f"{args.kind}: {report['summary']} digest={report['digest']}"
            print(summary_line)
        else:
            print(f"casesSha256={report['casesSha256']} digest={report['digest']}")
            for kind, item in report["baselines"].items():
                print(f"{kind}: {item['summary']} digest={item['digest']}")
    return 0


if __name__ == "__main__":
    sys.exit(_main())
