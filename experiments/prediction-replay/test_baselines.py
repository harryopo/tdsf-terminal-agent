"""基线单测：手算控制、泄漏防护、隔离与过滤顺序。"""

from __future__ import annotations

import unittest

import baselines


def make_event(event_id, namespace_id="ns-a", epoch="ep-1", sequence=1, t_ms=0,
               command="pwd", origin="user", exit_code=0, complete=True, recordable=True,
               cwd_key="cwd-a"):
    return {
        "eventId": event_id,
        "namespaceId": namespace_id,
        "epoch": epoch,
        "sequence": sequence,
        "tMs": t_ms,
        "cwdKey": cwd_key,
        "command": command,
        "origin": origin,
        "exitCode": exit_code,
        "complete": complete,
        "recordable": recordable,
    }


def make_query(**overrides):
    query = {
        "queryId": "q-1",
        "namespaceId": "ns-a",
        "epoch": "ep-1",
        "tMs": 4000,
        "afterEventId": "ev-4",
        "cwdKey": "cwd-a",
        "availability": {"pwd": "available", "ls": "available"},
    }
    query.update(overrides)
    return query


CONTROL_EVENTS = [
    make_event("ev-1", sequence=1, t_ms=0, command="pwd"),
    make_event("ev-2", sequence=2, t_ms=1000, command="ls"),
    make_event("ev-3", sequence=3, t_ms=2000, command="pwd"),
    make_event("ev-4", sequence=4, t_ms=3000, command="ls"),
]


class ControlTest(unittest.TestCase):
    """共享合同 C 节的手算控制。"""

    def test_mru_and_mfc_top2(self):
        query = make_query()
        for kind in ("mru", "mfc"):
            self.assertEqual(baselines.predict(kind, CONTROL_EVENTS, query), ["ls", "pwd"])

    def test_markov_top2(self):
        self.assertEqual(baselines.predict("markov", CONTROL_EVENTS, make_query()), ["pwd", "ls"])

    def test_rr_contract_values(self):
        import metrics

        self.assertEqual(metrics.score_next(["ls", "pwd"], "pwd")["rr5"], 0.5)
        self.assertEqual(metrics.score_next(["pwd", "ls"], "pwd")["rr5"], 1.0)

    def test_future_event_does_not_affect_earlier_query(self):
        future = CONTROL_EVENTS + [make_event("ev-5", sequence=5, t_ms=5000, command="uname -a")]
        query = make_query()
        for kind in ("mru", "mfc", "decay", "markov"):
            self.assertEqual(
                baselines.predict(kind, CONTROL_EVENTS, query),
                baselines.predict(kind, future[:4], query),
            )

    def test_future_event_in_history_raises(self):
        future = CONTROL_EVENTS + [make_event("ev-5", sequence=5, t_ms=4000, command="uname -a")]
        with self.assertRaises(ValueError):
            baselines.predict("mru", future, make_query())

    def test_gold_in_query_raises(self):
        query = make_query(gold="pwd")
        with self.assertRaises(ValueError):
            baselines.predict("markov", CONTROL_EVENTS, query)

    def test_unknown_kind_raises(self):
        with self.assertRaises(ValueError):
            baselines.predict("rank-v1", CONTROL_EVENTS, make_query())


class EligibilityTest(unittest.TestCase):
    def test_non_zero_exit_is_learnable(self):
        history = [
            make_event("ev-1", sequence=1, t_ms=0, command="grep -q x f", exit_code=1),
            make_event("ev-2", sequence=2, t_ms=1000, command="echo ok", exit_code=0),
        ]
        preds = baselines.predict(
            "mfc", history,
            make_query(tMs=2000, afterEventId="ev-2",
                       availability={"grep -q x f": "available", "echo ok": "available"}),
        )
        self.assertIn("grep -q x f", preds)

    def test_minus_one_and_null_exit_are_not_learnable(self):
        history = [
            make_event("ev-1", sequence=1, t_ms=0, command="ls -la", exit_code=-1),
            make_event("ev-2", sequence=2, t_ms=100, command="cat README.md", exit_code=None),
            make_event("ev-3", sequence=3, t_ms=200, command="tree -L 2", exit_code=0),
        ]
        preds = baselines.predict(
            "mfc", history,
            make_query(tMs=300, afterEventId="ev-3",
                       availability={"ls -la": "available", "cat README.md": "available",
                                     "tree -L 2": "available"}),
        )
        self.assertEqual(preds, ["tree -L 2"])

    def test_agent_probe_unknown_origin_not_learnable(self):
        history = [
            make_event("ev-1", sequence=1, t_ms=0, command="git status", origin="user"),
            make_event("ev-2", sequence=2, t_ms=100, command="kubectl get pods", origin="agent"),
            make_event("ev-3", sequence=3, t_ms=200, command="docker ps", origin="probe"),
            make_event("ev-4", sequence=4, t_ms=300, command="git diff", origin="unknown"),
            make_event("ev-5", sequence=5, t_ms=400, command="git branch --show-current"),
        ]
        availability = {cmd: "available" for cmd in (
            "git status", "kubectl get pods", "docker ps", "git diff",
            "git branch --show-current",
        )}
        preds = baselines.predict("mfc", history, make_query(tMs=500, afterEventId="ev-5",
                                                             availability=availability))
        self.assertEqual(preds, ["git branch --show-current", "git status"])

    def test_incomplete_event_not_learnable(self):
        history = [
            make_event("ev-1", sequence=1, t_ms=0, command="pwd", complete=False),
            make_event("ev-2", sequence=2, t_ms=1000, command="ls"),
        ]
        preds = baselines.predict(
            "mfc", history,
            make_query(tMs=2000, afterEventId="ev-2",
                       availability={"pwd": "available", "ls": "available"}),
        )
        self.assertEqual(preds, ["ls"])

    def test_recordable_false_with_command_rejected(self):
        bad = make_event("ev-bad", command="secret --token abc", recordable=False)
        with self.assertRaises(ValueError):
            baselines.predict("mru", [bad], make_query(tMs=100, afterEventId=None,
                                                       availability={}))

    def test_missing_event_field_rejected(self):
        bad = make_event("ev-bad")
        del bad["cwdKey"]
        with self.assertRaises(ValueError):
            baselines.predict("mru", [bad], make_query(tMs=100, afterEventId=None,
                                                       availability={}))


class IsolationTest(unittest.TestCase):
    def test_namespaces_do_not_share_counts(self):
        history = [
            make_event("ev-a1", namespace_id="ns-a", sequence=1, t_ms=0, command="git status"),
            make_event("ev-a2", namespace_id="ns-a", sequence=2, t_ms=1000, command="git log"),
            make_event("ev-b1", namespace_id="ns-b", sequence=1, t_ms=100, command="git status"),
            make_event("ev-b2", namespace_id="ns-b", sequence=2, t_ms=200, command="git status"),
            make_event("ev-b3", namespace_id="ns-b", sequence=3, t_ms=300, command="git status"),
        ]
        avail = {"git status": "available", "git log": "available"}
        preds_a = baselines.predict("mfc", history,
                                    make_query(tMs=2000, afterEventId="ev-a2",
                                               availability=avail))
        self.assertEqual(preds_a, ["git log", "git status"])

    def test_epoch_boundary_does_not_create_transition(self):
        history = [
            make_event("ev-e1", epoch="ep-1", sequence=1, t_ms=0, command="cd /tmp"),
            make_event("ev-e2", epoch="ep-1", sequence=2, t_ms=100, command="ls"),
            make_event("ev-e3", epoch="ep-1", sequence=3, t_ms=200, command="cd /tmp"),
            make_event("ev-e4", epoch="ep-2", sequence=1, t_ms=500, command="make"),
            make_event("ev-e5", epoch="ep-2", sequence=2, t_ms=600, command="make test"),
        ]
        avail = {"cd /tmp": "available", "ls": "available", "make": "available",
                 "make test": "available"}
        preds = baselines.predict("markov", history,
                                  make_query(tMs=1000, epoch="ep-1", afterEventId="ev-e3",
                                             availability=avail))
        self.assertEqual(preds[0], "ls")
        self.assertEqual(preds, ["ls", "cd /tmp", "make test", "make"])

    def test_sequence_gap_does_not_create_transition(self):
        history = [
            make_event("ev-1", sequence=1, t_ms=0, command="cd /tmp"),
            make_event("ev-2", sequence=2, t_ms=100, command="ls"),
            make_event("ev-4", sequence=4, t_ms=200, command="cat notes.md"),
            make_event("ev-5", sequence=5, t_ms=300, command="pwd"),
        ]
        avail = {cmd: "available" for cmd in ("cd /tmp", "ls", "cat notes.md", "pwd")}
        preds = baselines.predict("markov", history,
                                  make_query(tMs=400, afterEventId="ev-2", availability=avail))
        self.assertEqual(preds, ["pwd", "cat notes.md", "ls", "cd /tmp"])
        self.assertEqual(preds.index("cat notes.md"), 1)

    def test_privacy_drop_breaks_chain(self):
        history = [
            make_event("ev-1", sequence=1, t_ms=0, command="git push origin main"),
            make_event("ev-2", sequence=2, t_ms=100, command=None, recordable=False),
            make_event("ev-3", sequence=3, t_ms=200, command="git status"),
            make_event("ev-4", sequence=4, t_ms=300, command="git log"),
        ]
        avail = {"git push origin main": "available", "git status": "available",
                 "git log": "available"}
        preds = baselines.predict("markov", history,
                                  make_query(tMs=400, afterEventId="ev-1", availability=avail))
        self.assertEqual(preds, ["git log", "git status", "git push origin main"])
        self.assertEqual(preds.index("git status"), 1)

    def test_unreliable_predecessor_falls_back_to_mfc(self):
        history = [
            make_event("ev-1", sequence=1, t_ms=0, command="pwd"),
            make_event("ev-2", sequence=2, t_ms=100, command="ls"),
        ]
        avail = {"pwd": "available", "ls": "available"}
        # afterEventId 指向不存在的事件，不得猜最近合格项
        preds = baselines.predict("markov", history,
                                  make_query(tMs=1000, afterEventId="ev-missing",
                                             availability=avail))
        self.assertEqual(preds, ["ls", "pwd"])


class AvailabilityTest(unittest.TestCase):
    def test_filter_before_top5_truncation(self):
        names = ["kubectl get pods", "helm list", "kubectl describe pod web",
                 "docker compose ps", "make build", "make test", "ansible --version",
                 "grep -rn TODO src", "df -h"]
        commands = [
            "kubectl get pods", "helm list", "kubectl get pods", "kubectl describe pod web",
            "docker compose ps", "make build", "make test", "ansible --version",
            "kubectl get pods", "helm list", "grep -rn TODO src", "df -h",
        ]
        history = [
            make_event(f"ev-{i + 1}", sequence=i + 1, t_ms=i * 100, command=cmd)
            for i, cmd in enumerate(commands)
        ]
        availability = {name: "available" for name in names}
        availability.update({"kubectl get pods": "unavailable", "helm list": "unavailable",
                             "ansible --version": "unavailable"})
        query = make_query(tMs=1200, afterEventId="ev-12", availability=availability)
        preds = baselines.predict("mfc", history, query)
        self.assertEqual(
            preds,
            ["df -h", "grep -rn TODO src", "make test", "make build", "docker compose ps"],
        )
        self.assertNotIn("kubectl describe pod web", preds)

    def test_unknown_and_missing_availability_excluded(self):
        history = [
            make_event("ev-1", sequence=1, t_ms=0, command="vim main.py"),
            make_event("ev-2", sequence=2, t_ms=100, command="python3 -m pytest"),
            make_event("ev-3", sequence=3, t_ms=200, command="curl -sI https://example.com"),
            make_event("ev-4", sequence=4, t_ms=300, command="vim main.py"),
            make_event("ev-5", sequence=5, t_ms=400, command="python3 -m pytest"),
        ]
        query = make_query(tMs=500, afterEventId="ev-5",
                           availability={"vim main.py": "unknown",
                                         "python3 -m pytest": "available"})
        preds = baselines.predict("mfc", history, query)
        self.assertEqual(preds, ["python3 -m pytest"])

    def test_no_padding_when_fewer_than_five(self):
        history = [make_event("ev-1", sequence=1, t_ms=0, command="pwd"),
                   make_event("ev-2", sequence=2, t_ms=100, command="ls")]
        query = make_query(tMs=200, afterEventId="ev-2", availability={"pwd": "available"})
        self.assertEqual(baselines.predict("mru", history, query), ["pwd"])


class OrderingTest(unittest.TestCase):
    def test_literal_tie_break_by_unicode(self):
        history = [
            make_event("ev-1", sequence=1, t_ms=0, command="zeta"),
            make_event("ev-2", sequence=2, t_ms=0, command="alpha"),
        ]
        query = make_query(tMs=1000, afterEventId="ev-2",
                           availability={"zeta": "available", "alpha": "available"})
        for kind in ("mru", "mfc", "decay", "markov"):
            self.assertEqual(baselines.predict(kind, history, query), ["alpha", "zeta"])

    def test_decay_weights_recent_low_frequency_over_old_high_frequency(self):
        one_day = baselines.MS_PER_DAY
        history = [
            make_event("ev-old-1", sequence=1, t_ms=0, command="old cmd"),
            make_event("ev-old-2", sequence=2, t_ms=10, command="old cmd"),
            make_event("ev-old-3", sequence=3, t_ms=20, command="old cmd"),
            make_event("ev-new-1", sequence=4, t_ms=30 * one_day, command="new cmd"),
        ]
        query = make_query(tMs=30 * one_day + 1,
                           afterEventId="ev-new-1",
                           availability={"old cmd": "available", "new cmd": "available"})
        self.assertEqual(baselines.predict("mfc", history, query), ["old cmd", "new cmd"])
        self.assertEqual(baselines.predict("decay", history, query), ["new cmd", "old cmd"])

    def test_no_command_normalization(self):
        history = [
            make_event("ev-1", sequence=1, t_ms=0, command="ls"),
            make_event("ev-2", sequence=2, t_ms=100, command="LS"),
            make_event("ev-3", sequence=3, t_ms=200, command="ls  -l"),
        ]
        query = make_query(tMs=300, afterEventId="ev-3", availability={
            "ls": "available", "LS": "available", "ls  -l": "available"})
        preds = baselines.predict("mfc", history, query)
        self.assertEqual(len(preds), 3)
        self.assertEqual(len(set(preds)), 3)

    def test_cold_start_returns_empty(self):
        query = make_query(tMs=1000, afterEventId=None, availability={"pwd": "available"})
        for kind in ("mru", "mfc", "decay", "markov"):
            self.assertEqual(baselines.predict(kind, [], query), [])


class NegativeControlTest(unittest.TestCase):
    """把污染数据当作污染，结果必须与干净数据不同 —— 证明裁判确实过滤而非凑巧。"""

    def test_polluted_history_changes_result(self):
        clean = CONTROL_EVENTS
        polluted = [e.copy() for e in CONTROL_EVENTS]
        polluted[1]["origin"] = "agent"
        polluted[3]["origin"] = "probe"
        query = make_query()
        self.assertNotEqual(
            baselines.predict("mfc", clean, query),
            baselines.predict("mfc", polluted, query),
        )
        self.assertEqual(baselines.predict("mfc", polluted, query), ["pwd"])


if __name__ == "__main__":
    unittest.main()
