"""回放单测：手算期望全量比对、未来泄漏防护、digest 固定。"""

from __future__ import annotations

import copy
import unittest
from pathlib import Path

import baselines
import replay


CASES_PATH = Path(__file__).with_name("cases.json")


def load_cases():
    return replay.load_cases(CASES_PATH)


def without_gold(query: dict) -> dict:
    return {key: value for key, value in query.items() if key != "gold"}


def assert_matches_hand_expected(test: unittest.TestCase, cases: dict) -> None:
    """把回放结果与 cases.json 的人工手算期望逐条比对。"""
    events = cases["events"]
    for kind in baselines.KINDS:
        report = replay.replay(events, cases["queries"], kind)
        by_query = {item["queryId"]: item for item in report["perQuery"]}
        for query in cases["queries"]:
            query_id = query["queryId"]
            expected = cases["handExpected"][query_id][kind]
            actual = by_query[query_id]["predictions"]
            test.assertEqual(actual, expected, f"{query_id}/{kind} 预测与手算不符")
            expected_score = cases["handExpectedScores"][query_id][kind]
            actual_score = by_query[query_id]["metrics"]
            test.assertEqual(actual_score["rank"], expected_score["rank"])
            test.assertAlmostEqual(actual_score["rr5"], expected_score["rr5"], places=4)


class HandExpectedTest(unittest.TestCase):
    def test_all_queries_match_hand_computation(self):
        cases = load_cases()
        self.assertGreaterEqual(len(cases["queries"]), 12)
        assert_matches_hand_expected(self, cases)

    def test_hand_computation_covers_required_scenarios(self):
        cases = load_cases()
        ids = {q["queryId"] for q in cases["queries"]}
        required = {
            "q-control", "q-cold", "q-two-1", "q-two-2", "q-epoch", "q-gap-1",
            "q-gap-2", "q-priv", "q-nz", "q-unk", "q-src", "q-avail",
            "q-top5-1", "q-top5-2",
        }
        self.assertEqual(required - ids, set())

    def test_control_query_matches_contract(self):
        cases = load_cases()
        query = next(q for q in cases["queries"] if q["queryId"] == "q-control")
        history = [e for e in cases["events"] if e["tMs"] < query["tMs"]]
        stripped = without_gold(query)
        for kind in ("mru", "mfc"):
            self.assertEqual(baselines.predict(kind, history, stripped)[:2], ["ls", "pwd"])
        self.assertEqual(baselines.predict("markov", history, stripped)[:2], ["pwd", "ls"])
        self.assertEqual(replay.replay(cases["events"], [query], "mru")["summary"]["rr5"], 0.5)
        self.assertEqual(replay.replay(cases["events"], [query], "markov")["summary"]["rr5"], 1.0)


class WrongExpectedNegativeControlTest(unittest.TestCase):
    """故意写错期望，比对逻辑必须报错 —— 证明测试不是自证。"""

    def test_wrong_expected_is_detected(self):
        cases = load_cases()
        broken = copy.deepcopy(cases)
        broken["handExpected"]["q-control"]["mru"] = ["pwd", "ls"]
        with self.assertRaises(AssertionError):
            assert_matches_hand_expected(self, broken)

    def test_wrong_score_expectation_is_detected(self):
        cases = load_cases()
        broken = copy.deepcopy(cases)
        broken["handExpectedScores"]["q-control"]["markov"] = {"rank": 2, "rr5": 0.5}
        with self.assertRaises(AssertionError):
            assert_matches_hand_expected(self, broken)


class LeakageTest(unittest.TestCase):
    def test_future_events_do_not_change_earlier_queries(self):
        cases = load_cases()
        query = next(q for q in cases["queries"] if q["queryId"] == "q-control")
        base_events = [e for e in cases["events"] if e["tMs"] < query["tMs"]]
        injected = copy.deepcopy(base_events)
        injected.append({
            "eventId": "ev-injected", "namespaceId": query["namespaceId"],
            "epoch": query["epoch"], "sequence": 99, "tMs": query["tMs"] + 1,
            "cwdKey": query["cwdKey"], "command": "hostname", "origin": "user",
            "exitCode": 0, "complete": True, "recordable": True,
        })
        for kind in baselines.KINDS:
            self.assertEqual(
                baselines.predict(kind, base_events, without_gold(query)),
                replay.replay(injected, [query], kind)["perQuery"][0]["predictions"],
            )

    def test_replay_refuses_future_event_in_history_slice(self):
        # 直接调用 predict 传入含未来事件的 history 必须 ValueError（数据层护栏）
        query = {
            "queryId": "q-x", "namespaceId": "ns-x", "epoch": "ep-x", "tMs": 1000,
            "afterEventId": None, "availability": {},
        }
        future = {
            "eventId": "ev-f", "namespaceId": "ns-x", "epoch": "ep-x", "sequence": 1,
            "tMs": 1000, "cwdKey": "cwd-x", "command": "pwd", "origin": "user",
            "exitCode": 0, "complete": True, "recordable": True,
        }
        with self.assertRaises(ValueError):
            baselines.predict("mru", [future], query)


class DeterminismTest(unittest.TestCase):
    def test_replay_all_digest_is_stable(self):
        cases = load_cases()
        first = replay.replay_all(cases)
        second = replay.replay_all(copy.deepcopy(cases))
        self.assertEqual(first["digest"], second["digest"])
        self.assertEqual(first["casesSha256"], second["casesSha256"])

    def test_digest_changes_when_case_content_changes(self):
        cases = load_cases()
        mutated = copy.deepcopy(cases)
        mutated["events"][0]["command"] = "hostname"
        self.assertNotEqual(
            replay.replay_all(cases)["digest"],
            replay.replay_all(mutated)["digest"],
        )

    def test_per_kind_digest_is_stable(self):
        cases = load_cases()
        for kind in baselines.KINDS:
            a = replay.replay(cases["events"], cases["queries"], kind)
            b = replay.replay(copy.deepcopy(cases["events"]), copy.deepcopy(cases["queries"]), kind)
            self.assertEqual(a["digest"], b["digest"])


class ReportShapeTest(unittest.TestCase):
    def test_denominator_includes_empty_results(self):
        cases = load_cases()
        report = replay.replay(cases["events"], cases["queries"], "mru")
        self.assertEqual(report["summary"]["n"], len(cases["queries"]))
        self.assertEqual(
            report["summary"]["n"],
            sum(1 for item in report["perQuery"] if item["metrics"]["nonEmpty"])
            + sum(1 for item in report["perQuery"] if not item["metrics"]["nonEmpty"]),
        )

    def test_cold_start_is_reported_separately(self):
        cases = load_cases()
        report = replay.replay(cases["events"], cases["queries"], "mru")
        self.assertEqual(report["coldStart"]["queryIds"], ["q-cold"])
        self.assertEqual(report["coldStart"]["n"], 1)
        self.assertEqual(report["coldStart"]["metrics"]["rr5"], 0.0)

    def test_duplicate_query_id_rejected(self):
        cases = load_cases()
        duplicated = [cases["queries"][0], cases["queries"][0]]
        with self.assertRaises(ValueError):
            replay.replay(cases["events"], duplicated, "mru")


if __name__ == "__main__":
    unittest.main()
