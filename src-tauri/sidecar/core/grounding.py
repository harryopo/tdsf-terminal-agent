"""
core/grounding.py — 证据溯源校验（T-P1-06 迁移自 projects/src/tdsf/core/grounding.py）
========================================================================================

迁移说明：
- 完整保留原 Ground-Check 逻辑（精确匹配 + 模糊匹配）
- 调整导入路径：tdsf.storage.schemas → core.schemas
- Confidence 计算器依赖本模块的 is_grounded 标记

实现方案书 4.2 节的 Ground-Check 机制：
Evidence Chain 里的每条证据，在进入最终结论之前，
必须证明自己「确实来自某一次真实的工具调用」，
而不是模型顺着上下文编出来的话。

校验流程：
1. 精确匹配：``evidence.raw_text in record.output``
2. 模糊匹配（精确匹配失败时）：基于 ``difflib.SequenceMatcher``
   计算相似度，阈值 0.8
3. 通过校验的证据 ``is_grounded = True``，否则标记为疑似幻觉
"""

from __future__ import annotations

from difflib import SequenceMatcher

from pydantic import BaseModel, Field

from core.schemas import Evidence, ToolCallRecord

# ============================================================
# 常量定义
# ============================================================

# 模糊匹配相似度阈值：高于此值视为同一来源（容忍空白 / 大小写差异）
FUZZY_MATCH_THRESHOLD: float = 0.8

# pass_rate 保留小数位数
_PASS_RATE_PRECISION: int = 3


# ============================================================
# 校验结果模型
# ============================================================


class GroundCheckResult(BaseModel):
    """Ground-Check 校验结果。

    汇总一次溯源校验的所有输出：
    - 通过校验的证据列表（``is_grounded=True``）
    - 被拒绝的证据列表（疑似幻觉，``is_grounded=False``）
    - 通过率与是否全部通过标志
    """

    verified: list[Evidence] = Field(
        default_factory=list,
        description="通过溯源校验的证据列表",
    )
    rejected: list[Evidence] = Field(
        default_factory=list,
        description="未通过校验的证据列表（疑似幻觉）",
    )
    pass_rate: float = Field(
        default=1.0,
        ge=0.0,
        le=1.0,
        description="通过率 = verified / total",
    )
    all_grounded: bool = Field(
        default=True,
        description="是否全部通过校验",
    )


# ============================================================
# 溯源校验器
# ============================================================


class GroundChecker:
    """证据溯源校验器。

    对证据链中的每条证据，检查其 ``raw_text`` 是否能在
    某次真实工具调用的输出中找到来源。无法找到来源的证据
    被视为「疑似幻觉」，不进入最终证据链。
    """

    def __init__(self) -> None:
        """初始化溯源校验器。

        当前无内部状态，保留构造方法以便后续扩展
        （如自定义相似度算法、缓存等）。
        """
        # 预留扩展点：未来可注入自定义相似度计算器
        return

    # ----------------------------------------------------------
    # 单条证据溯源
    # ----------------------------------------------------------

    def check_single(
        self,
        evidence: Evidence,
        tool_call_records: list[ToolCallRecord],
    ) -> bool:
        """检查单条证据是否可溯源。

        校验顺序：
        1. 精确匹配：``evidence.raw_text`` 是否是某个工具输出的子串
        2. 模糊匹配：与工具输出片段的最高相似度是否 >= 0.8

        Args:
            evidence: 待校验的证据对象。
            tool_call_records: 工具调用记录列表（作为溯源依据）。

        Returns:
            True 表示可溯源（通过校验）；
            False 表示无法溯源（疑似幻觉）。
        """
        # 无工具调用记录：无法溯源
        if not tool_call_records:
            return False

        # 空文本证据：视为无法溯源（避免空串匹配命中所有输出）
        if not evidence.raw_text:
            return False

        # 第 1 步：精确匹配（子串包含）
        for record in tool_call_records:
            if self._exact_match(evidence.raw_text, record.output):
                return True

        # 第 2 步：模糊匹配（相似度 >= 阈值）
        for record in tool_call_records:
            if self._fuzzy_match(evidence.raw_text, record.output):
                return True

        # 精确 + 模糊均未命中：疑似幻觉
        return False

    # ----------------------------------------------------------
    # 证据链批量溯源
    # ----------------------------------------------------------

    def check(
        self,
        evidence_chain: list[Evidence],
        tool_call_records: list[ToolCallRecord],
    ) -> GroundCheckResult:
        """对证据链做批量溯源校验。

        Args:
            evidence_chain: 待校验的证据链。
            tool_call_records: 工具调用记录列表（作为溯源依据）。

        Returns:
            ``GroundCheckResult`` 校验结果，包含通过 / 拒绝列表、
            通过率与全部通过标志。

        说明：
        - 空证据链视为「全部通过」（无证据需拒绝），``pass_rate=1.0``。
        - 通过校验的证据 ``is_grounded`` 置为 True；
          被拒绝的证据 ``is_grounded`` 置为 False。
        - 为避免修改入参证据对象，本方法对证据做浅拷贝再写回标记。
        """
        # 空证据链：约定为全部通过（无证据可拒绝）
        if not evidence_chain:
            return GroundCheckResult(
                verified=[],
                rejected=[],
                pass_rate=1.0,
                all_grounded=True,
            )

        verified: list[Evidence] = []
        rejected: list[Evidence] = []

        # 逐条校验，按结果分组并写回 is_grounded 标记
        for evidence in evidence_chain:
            is_grounded = self.check_single(evidence, tool_call_records)
            # 浅拷贝避免污染调用方传入的证据对象
            evidence_copy = evidence.model_copy(deep=False)
            evidence_copy.is_grounded = is_grounded
            if is_grounded:
                verified.append(evidence_copy)
            else:
                rejected.append(evidence_copy)

        # 计算通过率：verified / total，保留 3 位小数
        total: int = len(evidence_chain)
        pass_rate: float = round(len(verified) / total, _PASS_RATE_PRECISION)
        all_grounded: bool = len(rejected) == 0

        return GroundCheckResult(
            verified=verified,
            rejected=rejected,
            pass_rate=pass_rate,
            all_grounded=all_grounded,
        )

    # ----------------------------------------------------------
    # 内部匹配方法
    # ----------------------------------------------------------

    @staticmethod
    def _exact_match(raw_text: str, output: str) -> bool:
        """精确匹配：raw_text 是否是 output 的子串。

        Args:
            raw_text: 证据原始文本。
            output: 工具调用输出。

        Returns:
            True 表示 raw_text 完整出现在 output 中。
        """
        # 空串不应匹配（已在调用方保证 raw_text 非空）
        if not raw_text or not output:
            return False
        return raw_text in output

    @staticmethod
    def _fuzzy_match(raw_text: str, output: str) -> bool:
        """模糊匹配：raw_text 与 output 的最高片段相似度是否 >= 阈值。

        采用双重判定，避免 output 远长于 raw_text 时
        ``SequenceMatcher.ratio()`` 被稀释的问题：

        1. **最长匹配覆盖率**：用 ``SequenceMatcher.get_matching_blocks()``
           取最长连续公共子串，计算其占 raw_text 的比例
           （coverage = longest_match / len(raw_text)）。
           coverage >= 阈值即视为匹配。
        2. **整体相似度兜底**：若 output 不长，直接用 ``ratio()``
           作为整体相似度判定。

        Args:
            raw_text: 证据原始文本。
            output: 工具调用输出。

        Returns:
            True 表示存在相似度 >= ``FUZZY_MATCH_THRESHOLD`` 的片段。
        """
        if not raw_text or not output:
            return False

        raw_len: int = len(raw_text)

        # 快速路径：output 较短时直接整体比对 ratio
        if len(output) <= max(raw_len * 2, 200):
            ratio: float = SequenceMatcher(None, raw_text, output).ratio()
            return ratio >= FUZZY_MATCH_THRESHOLD

        # 主路径：最长连续公共子串覆盖率
        # 适用于 output 远长于 raw_text 的场景，避免 ratio 被稀释
        matcher = SequenceMatcher(None, raw_text, output, autojunk=False)
        matching_blocks = matcher.get_matching_blocks()
        # 取最长的匹配块（最后一个元素是哨兵 (0, 0, 0)，忽略）
        longest_match: int = 0
        for block in matching_blocks:
            if block.size > longest_match:
                longest_match = block.size

        coverage: float = longest_match / raw_len
        if coverage >= FUZZY_MATCH_THRESHOLD:
            return True

        # 兜底：整体相似度（处理 raw_text 内部多次小匹配的情况）
        overall_ratio = matcher.ratio()
        return overall_ratio >= FUZZY_MATCH_THRESHOLD
