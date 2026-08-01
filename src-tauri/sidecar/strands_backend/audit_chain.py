"""
strands_backend/audit_chain.py — hash-chained 审计链（P1-3）
================================================================

把工具调用、审批决策等敏感操作记录为**防篡改审计链**（OpAgent 范式）：

- 每条记录 = {seq, timestamp, prev_hash, entry, hash}
- hash = sha256(prev_hash + canonical_json(entry))
- 修改/删除/插入任意历史记录都会导致后续所有 hash 失配 → verify() 可检测
- 落盘为 JSONL（.tdsf-data/audit-chain.jsonl），追加写，进程重启不丢

用法：
    chain = AuditChain(path)
    chain.append({"event": "tool_call", "tool": "ssh_command", "command": "..."})
    ok, bad = chain.verify()   # (是否完整, 失配段列表)

设计：
- 单例（get_global_chain）供 sidecar 全局共享；测试可用临时路径
- 写锁防并发交错（sidecar 线程池多线程）
- entry 必须 JSON 可序列化（工具调用会先脱敏）
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.audit_chain")

_AUDIT_DIR_NAME = ".tdsf-data"
_AUDIT_FILE_NAME = "audit-chain.jsonl"


class AuditChain:
    """防篡改审计链（sha256 前后链）"""

    def __init__(self, path: str | None = None) -> None:
        self.path = path or self._default_path()
        self._lock = threading.Lock()
        self._seq = 0
        self._last_hash = _GENESIS_HASH
        self._load_tail()

    # ========================================================================
    # 写入
    # ========================================================================

    def append(self, entry: dict[str, Any]) -> dict[str, Any]:
        """追加一条审计记录，返回带 hash 的完整记录

        Args:
            entry: 审计内容（必须 JSON 可序列化；敏感字段先脱敏再入链）

        Returns:
            记录 dict（含 seq / timestamp / prev_hash / entry / hash）
        """
        with self._lock:
            self._seq += 1
            record = {
                "seq": self._seq,
                "timestamp": time.time(),
                "prev_hash": self._last_hash,
                "entry": entry,
            }
            record["hash"] = self._hash_record(record)
            self._last_hash = record["hash"]
            self._persist(record)
            return record

    # ========================================================================
    # 校验
    # ========================================================================

    def verify(self) -> tuple[bool, list[dict[str, Any]]]:
        """校验整条链的完整性

        Returns:
            (ok, bad_segments):
                ok: 链完整为 True
                bad_segments: 失配记录列表 [{seq, reason, expected, actual}]
        """
        bad: list[dict[str, Any]] = []
        prev_hash = _GENESIS_HASH
        expect_seq = 0
        with self._lock:
            for rec in self._read_all():
                seq = rec.get("seq")
                # 1. 序号连续性
                if seq != expect_seq + 1:
                    bad.append({"seq": seq, "reason": "seq 不连续"})
                # 2. prev_hash 链
                if rec.get("prev_hash") != prev_hash:
                    bad.append(
                        {
                            "seq": seq,
                            "reason": "prev_hash 失配（历史被修改）",
                            "expected": prev_hash,
                            "actual": rec.get("prev_hash"),
                        }
                    )
                # 3. 自身 hash
                rec_hash = rec.get("hash")
                recomputed = self._hash_record(rec)
                if rec_hash != recomputed:
                    bad.append(
                        {
                            "seq": seq,
                            "reason": "hash 失配（记录被修改）",
                            "expected": recomputed,
                            "actual": rec_hash,
                        }
                    )
                prev_hash = rec.get("hash") or _GENESIS_HASH
                expect_seq = seq
        return (len(bad) == 0, bad)

    def count(self) -> int:
        with self._lock:
            return len(self._read_all())

    def tail(self, limit: int = 10) -> list[dict[str, Any]]:
        """最近 limit 条记录（不含 hash 计算字段的展示简化）"""
        with self._lock:
            recs = self._read_all()
        return recs[-limit:]

    # ========================================================================
    # 内部
    # ========================================================================

    @staticmethod
    def _hash_record(record: dict[str, Any]) -> str:
        """sha256(prev_hash + canonical_json(entry + seq + timestamp))"""
        body = {
            "seq": record["seq"],
            "timestamp": record["timestamp"],
            "prev_hash": record["prev_hash"],
            "entry": record["entry"],
        }
        canonical = json.dumps(
            body, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _persist(self, record: dict[str, Any]) -> None:
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(
                    json.dumps(record, ensure_ascii=False, separators=(",", ":"))
                    + "\n"
                )
        except OSError as e:
            logger.warning(f"audit chain persist failed: {e}")

    def _read_all(self) -> list[dict[str, Any]]:
        if not os.path.exists(self.path):
            return []
        try:
            with open(self.path, encoding="utf-8") as f:
                return [json.loads(line) for line in f if line.strip()]
        except (OSError, json.JSONDecodeError) as e:
            logger.warning(f"audit chain read failed: {e}")
            return []

    def _load_tail(self) -> None:
        """启动时从文件尾部恢复 seq / last_hash"""
        recs = self._read_all()
        if not recs:
            return
        last = recs[-1]
        self._seq = int(last.get("seq", 0))
        self._last_hash = last.get("hash") or _GENESIS_HASH

    @staticmethod
    def _default_path() -> str:
        base = os.environ.get("TDSF_DATA_DIR", "")
        if base:
            return os.path.join(base, _AUDIT_FILE_NAME)
        home = os.path.expanduser("~")
        return os.path.join(home, _AUDIT_DIR_NAME, _AUDIT_FILE_NAME)


# 创世哈希（空链起点）
_GENESIS_HASH = hashlib.sha256(b"tdsf-audit-genesis-v1").hexdigest()

# ============================================================================
# 全局单例
# ============================================================================

_global_chain: AuditChain | None = None
_global_chain_lock = threading.Lock()


def get_global_chain() -> AuditChain:
    """获取全局审计链单例"""
    global _global_chain
    with _global_chain_lock:
        if _global_chain is None:
            _global_chain = AuditChain()
        return _global_chain


def reset_global_chain(path: str | None = None) -> AuditChain:
    """重置全局单例（测试用，path 指定临时链文件）"""
    global _global_chain
    with _global_chain_lock:
        _global_chain = AuditChain(path=path)
        return _global_chain


__all__ = ["AuditChain", "get_global_chain", "reset_global_chain"]
