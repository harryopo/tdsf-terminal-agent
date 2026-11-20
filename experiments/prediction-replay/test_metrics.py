"""计分单测：精确匹配、无需规范化、错误期望的负控制。"""

from __future__ import annotations

import unittest

import metrics


class ScoreNextTest(unittest.TestCase):
    def test_rank_positions(self):
        gold = "ls"
        cases = [
            (["ls", "pwd"], 1, 1.0),
            (["pwd", "ls"], 2, 0.5),
            (["a", "b", "ls", "c"], 3, 1.0 / 3.0),
            (["a", "b", "c", "ls"], 4, 0.25),
            (["a", "b", "c", "d", "ls"], 5, 0.2),
            (["a", "b", "c", "d", "e"], None, 0.0),
        ]
        for predictions, rank, rr in cases:
            score = metrics.score_next(predictions, gold)
            self.assertEqual(score["rank"], rank)
            self.assertEqual(score["rr5"], rr)
            self.assertEqual(score["hit1"], rank == 1)
            self.assertEqual(score["hit5"], rank is not None and rank <= 5)

    def test_exact_text_match_only(self):
        for prediction in ("ls -l", "LS", "ls ", "ls  -l", "ls\n"):
            self.assertEqual(metrics.score_next([prediction], "ls")["rr5"], 0.0)

    def test_empty_predictions(self):
        score = metrics.score_next([], "pwd")
        self.assertEqual(score["rank"], None)
        self.assertEqual(score["rr5"], 0.0)
        self.assertFalse(score["nonEmpty"])
        self.assertFalse(score["hit5"])

    def test_rejects_malformed(self):
        with self.assertRaises(ValueError):
            metrics.score_next(["a", "a"], "a")
        with self.assertRaises(ValueError):
            metrics.score_next(["a", "b", "c", "d", "e", "f"], "a")
        with self.assertRaises(ValueError):
            metrics.score_next(["a", 1], "a")
        with self.assertRaises(ValueError):
            metrics.score_next(["a"], "")


class AggregateTest(unittest.TestCase):
    def test_empty_scores_not_dropped_from_denominator(self):
        scores = [
            metrics.score_next(["ls", "pwd"], "pwd"),  # rr 0.5
            metrics.score_next([], "pwd"),            # rr 0
            metrics.score_next(["pwd"], "pwd"),       # rr 1
        ]
        summary = metrics.aggregate_scores(scores)
        self.assertEqual(summary["n"], 3)
        self.assertEqual(summary["rr5"], 0.5)
        self.assertEqual(summary["hit1"], 1 / 3)
        self.assertEqual(summary["nonEmpty"], 2 / 3)

    def test_empty_batch(self):
        summary = metrics.aggregate_scores([])
        self.assertEqual(summary["n"], 0)
        self.assertIsNone(summary["rr5"])
