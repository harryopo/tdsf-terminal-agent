from uuid import UUID

import pytest

from strands_backend.evidence import (
    EvidenceTracker,
    register_methods,
    reset_global_tracker,
)


class RpcDispatcher:
    def __init__(self):
        self.methods = {}

    def register(self, name, handler):
        self.methods[name] = handler


def test_record_owns_unique_evidence_id_and_rpc_returns_the_same_id():
    tracker = reset_global_tracker()
    assert isinstance(tracker, EvidenceTracker)
    dispatcher = RpcDispatcher()
    register_methods(dispatcher)

    first = tracker.record(
        "evidence-id-session",
        "ssh_command",
        "completed",
        result={"output": "ok", "evidence_id": "untrusted-result-id"},
        tool_call_id="actual-call-1",
        sdk_tool_use_id="actual-sdk-1",
        operation_id="actual-operation-1",
    )
    second = tracker.record("evidence-id-session", "ssh_command", "completed")

    first_id = UUID(first["evidence_id"])
    second_id = UUID(second["evidence_id"])
    assert first_id != second_id
    other = tracker.record("other-session", "ssh_command", "completed")
    other_id = UUID(other["evidence_id"])
    assert other_id not in {first_id, second_id}
    assert tracker.list("other-session")[0]["evidence_id"] == str(other_id)
    assert str(first_id) not in {"actual-call-1", "actual-sdk-1", "actual-operation-1"}
    assert first["tool_call_id"] == "actual-call-1"
    assert first["sdk_tool_use_id"] == "actual-sdk-1"
    assert first["operation_id"] == "actual-operation-1"
    assert first["status"] == "completed"
    listed = dispatcher.methods["evidence.list"]("evidence-id-session")
    assert [item["evidence_id"] for item in listed] == [str(first_id), str(second_id)]
    assert listed[0]["evidence_id"] != "untrusted-result-id"
    first["detail"] = "mutated return"
    listed[0]["detail"] = "mutated list"
    assert tracker.list("evidence-id-session")[0]["detail"] == ""
    assert dispatcher.methods["evidence.assess"]("evidence-id-session")["tier"] == "grounded"
    assert dispatcher.methods["evidence.clear"]("evidence-id-session") == 2
    assert dispatcher.methods["evidence.list"]("evidence-id-session") == []


@pytest.mark.parametrize("length", [499, 500, 501])
def test_detail_and_summary_truncation_flags_match_actual_500_character_limit(length):
    tracker = EvidenceTracker()
    evidence = tracker.record(
        f"length-{length}",
        "read_remote_file",
        "completed",
        detail="d" * length,
        result={"output": "o" * length},
    )

    assert len(evidence["detail"]) == min(length, 500)
    assert len(evidence["result"]) == min(length, 500)
    assert evidence["detail_truncated"] is (length > 500)
    assert evidence["summary_truncated"] is (length > 500)


def test_dict_fallback_summary_uses_200_character_truncation_limit():
    tracker = EvidenceTracker()
    template_length = len(str({"meta": ""}))
    for target_length in (199, 200, 201):
        payload = {"meta": "x" * (target_length - template_length)}
        assert len(str(payload)) == target_length
        evidence = tracker.record(str(target_length), "ssh_command", "completed", result=payload)
        assert len(evidence["result"]) == min(target_length, 200)
        assert evidence["summary_truncated"] is (target_length > 200)


@pytest.mark.parametrize(
    ("result", "summary", "truncated"),
    [
        (None, "", False),
        ({}, "{}", False),
        ({"output": "  alpha\n\t beta  "}, "alpha beta", False),
    ],
)
def test_empty_and_whitespace_summaries_are_normalized(result, summary, truncated):
    evidence = EvidenceTracker().record(
        "summary-session", "ssh_command", "completed", result=result
    )
    assert evidence["result"] == summary
    assert evidence["summary_truncated"] is truncated
    assert "exit_code" not in evidence


def test_standard_secret_redactor_runs_before_summary_storage():
    secret = "sk-proj-abcdefghijklmnopqrstuvwxyz012345"
    evidence = EvidenceTracker().record(
        "redaction-session",
        "ssh_command",
        "completed",
        detail=f"Authorization: Bearer {secret}",
        result={"output": f"Authorization: Bearer {secret}"},
    )
    assert secret not in evidence["detail"]
    assert secret not in evidence["result"]


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        ({"truncated": True}, True),
        ({"truncated": False}, False),
        ({"truncated": None}, None),
        ({"truncated": "true"}, None),
        ({"truncated": 1}, None),
        ({}, None),
    ],
)
def test_output_truncated_preserves_only_boolean_values(fields, expected):
    result = {"output": "ok", **fields}
    evidence = EvidenceTracker().record(
        "truncated-session", "ssh_command", "completed", result=result
    )
    if expected is None:
        assert "output_truncated" not in evidence
    else:
        assert evidence["output_truncated"] is expected


@pytest.mark.parametrize(
    ("exit_code", "expected"),
    [(0, 0), (7, 7), (-1, None), (None, None), ("3", None), (3.0, None), (True, None)],
)
def test_exit_code_keeps_only_nonnegative_nonboolean_integers(exit_code, expected):
    evidence = EvidenceTracker().record(
        "exit-session", "ssh_command", "completed", result={"output": "ok", "exit_code": exit_code}
    )
    if expected is None:
        assert "exit_code" not in evidence
    else:
        assert evidence["exit_code"] == expected


def test_empty_session_is_not_recorded_and_capacity_evicts_without_reusing_ids():
    tracker = EvidenceTracker()
    assert tracker.record("", "ssh_command", "completed") is None
    assert tracker.list("") == []
    all_ids = []
    for index in range(201):
        evidence = tracker.record("bounded-session", "ssh_command", "completed", detail=str(index))
        all_ids.append(evidence["evidence_id"])
    retained = tracker.list("bounded-session")
    assert len(retained) == 200
    assert retained[0]["detail"] == "1"
    assert len(set(all_ids)) == 201
    assert tracker.clear("bounded-session") == 200
    after_clear = tracker.record("bounded-session", "ssh_command", "completed")
    assert after_clear["evidence_id"] not in all_ids


def test_record_marks_detail_and_summary_truncation_after_preserving_limit():
    tracker = EvidenceTracker()
    evidence = tracker.record(
        "truncation-session",
        "read_remote_file",
        "completed",
        detail="d" * 501,
        result={"output": "o" * 501},
    )

    assert len(evidence["detail"]) == 500
    assert len(evidence["result"]) == 500
    assert evidence["detail_truncated"] is True
    assert evidence["summary_truncated"] is True


def test_record_preserves_structured_exit_and_output_truncation_metadata():
    tracker = EvidenceTracker()
    evidence = tracker.record(
        "structured-session",
        "ssh_command",
        "completed",
        result={"output": "ok", "exit_code": 3, "truncated": True},
    )

    assert evidence["status"] == "completed"
    assert evidence["result"] == "ok"
    assert evidence["output_truncated"] is True
    assert evidence["exit_code"] == 3
