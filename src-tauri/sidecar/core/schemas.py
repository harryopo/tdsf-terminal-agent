"""
core/schemas.py — 核心数据模型（T-P1-06 迁移自 projects/src/tdsf/storage/schemas.py）
========================================================================================

迁移原则（用户决策④：仅复用 RiskEngine + Confidence）：
- 保留 RiskEngine / Confidence / Grounding 依赖的核心模型
- 移除原项目中 LangGraph AgentState（已在新 graph/state.py 重写）
- 移除 DecisionCard 等决策相关模型（DecisionEngine 用 LangGraph 重写）
- 新增 L0-L4 风险等级映射方法（spec 要求 4 档风险：L0-L4）

模型清单：
- RiskLevel:        风险等级枚举（low/medium/high/deny，原 4 档）
- RiskAssessment:   风险评估结果
- Evidence:         单条证据
- EvidenceSource:   证据来源枚举
- Hypothesis:       因果推理假设
- RootCause:        根因分析结果
- ToolCallRecord:   工具调用记录
- SOURCE_PRIOR:     来源先验权重表

L0-L4 映射规则（spec 4 档 × 3 mode 权限融合）：
- low    → L0 (Safe)     或 L1 (Caution)
- medium → L2 (Warning)
- high   → L3 (Danger)
- deny   → L4 (Critical)
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator


# ============================================================
# 枚举类型
# ============================================================


class RiskLevel(str, Enum):
    """命令风险等级（原 4 档，与 risk_rules.yaml 对齐）。

    与 spec 中 L0-L4 的映射关系：
    - LOW    → L0/L1（Safe / Caution）
    - MEDIUM → L2   (Warning)
    - HIGH   → L3   (Danger)
    - DENY   → L4   (Critical)
    """

    LOW = "low"        # 只读诊断，可自动执行 → L0/L1
    MEDIUM = "medium"  # 配置变更，需人工确认 → L2
    HIGH = "high"      # 不可逆操作，强制确认 + 审计 → L3
    DENY = "deny"      # 禁止执行 → L4


class ReasoningMode(str, Enum):
    """推理模式（双推理模式：快速 / 深度）。"""

    FAST = "fast"      # 快速模式：简单问题单步回答
    DEEP = "deep"      # 深度模式：多步推理 + 证据核验


class EvidenceSource(str, Enum):
    """日志来源（用于 source_prior 先验权重）。"""

    DMESG = "dmesg"                  # 内核日志（先验 0.95）
    MYSQL_ERROR = "mysql/error.log"  # MySQL 错误日志（先验 0.90）
    NGINX_ERROR = "nginx/error.log"  # Nginx 错误日志（先验 0.88）
    SYSLOG = "syslog"                # 系统日志（先验 0.85）
    JOURNALCTL = "journalctl"        # systemd 日志（先验 0.85）
    APP_LOG = "app.log"              # 应用日志（先验 0.75）
    UNKNOWN = "unknown"              # 未知来源（先验 0.50）


class DecisionStatus(str, Enum):
    """Decision Card 处理状态（HITL 状态机）。"""

    PENDING = "pending"                       # 待处理
    WAITING_APPROVAL = "waiting_approval"     # 等待人工审批
    APPROVED = "approved"                     # 已批准
    REJECTED = "rejected"                     # 已拒绝
    EXECUTING = "executing"                   # 执行中
    SUCCESS = "success"                       # 执行成功
    FAILED = "failed"                         # 执行失败
    ROLLED_BACK = "rolled_back"               # 已回滚


# ============================================================
# 来源先验权重表（source_prior）
# ============================================================

SOURCE_PRIOR: dict[EvidenceSource, float] = {
    EvidenceSource.DMESG: 0.95,
    EvidenceSource.MYSQL_ERROR: 0.90,
    EvidenceSource.NGINX_ERROR: 0.88,
    EvidenceSource.SYSLOG: 0.85,
    EvidenceSource.JOURNALCTL: 0.85,
    EvidenceSource.APP_LOG: 0.75,
    EvidenceSource.UNKNOWN: 0.50,
}


# ============================================================
# L0-L4 风险等级映射（spec 要求的 4 档 × 3 mode 权限融合）
# ============================================================

# RiskLevel → L0-L4 字符串映射
# 低风险统一映射为 L0（Safe），实际场景可根据命令具体特征细化为 L1（Caution）
_RISK_LEVEL_TO_L0_L4: dict[RiskLevel, str] = {
    RiskLevel.LOW: "L0",      # Safe
    RiskLevel.MEDIUM: "L2",   # Warning
    RiskLevel.HIGH: "L3",     # Danger
    RiskLevel.DENY: "L4",     # Critical
}

# L0-L4 数值（用于权限融合矩阵比较）
_L0_L4_NUMERIC: dict[str, int] = {
    "L0": 0,
    "L1": 1,
    "L2": 2,
    "L3": 3,
    "L4": 4,
}


def risk_level_to_l0_l4(level: RiskLevel) -> str:
    """将原 RiskLevel（low/medium/high/deny）映射为 L0-L4 字符串。

    Args:
        level: 原 RiskLevel 枚举值

    Returns:
        L0-L4 字符串（"L0" / "L1" / "L2" / "L3" / "L4"）
    """
    return _RISK_LEVEL_TO_L0_L4.get(level, "L2")


def l0_l4_to_numeric(level: str) -> int:
    """将 L0-L4 字符串转为数值（用于权限融合矩阵比较）。

    Args:
        level: L0-L4 字符串

    Returns:
        0-4 整数
    """
    return _L0_L4_NUMERIC.get(level, 2)


# ============================================================
# 基础数据模型
# ============================================================


class ToolCallRecord(BaseModel):
    """工具调用记录（用于证据溯源校验 Ground-Check）。

    每次只读诊断工具调用都会生成一条记录，
    Ground-Check 模块据此验证证据是否来自真实工具输出。
    """

    tool_name: str = Field(description="工具名称，如 grep / df / journalctl")
    command: str = Field(description="实际执行的命令")
    output: str = Field(description="命令原始输出")
    exit_code: int = Field(default=0, description="退出码，0 表示成功")
    executed_at: datetime = Field(
        default_factory=datetime.now,
        description="执行时间戳",
    )


class Evidence(BaseModel):
    """单条证据。

    证据是推理的最小单元，每条证据必须：
    1. 标注来源（哪个日志文件 / 哪个工具输出）
    2. 标注可信度（Drain3 模板匹配度 × 0.7 + 来源先验 × 0.3）
    3. 可追溯到具体日志行或工具调用
    """

    id: UUID = Field(default_factory=uuid4, description="证据唯一 ID")
    raw_text: str = Field(description="证据原始文本（日志行或工具输出片段）")
    source: EvidenceSource = Field(
        default=EvidenceSource.UNKNOWN,
        description="证据来源",
    )
    source_file: str = Field(default="", description="来源文件路径")
    line_number: int | None = Field(
        default=None,
        description="日志行号（如可定位）",
    )
    timestamp: datetime | None = Field(
        default=None,
        description="日志时间戳（如可解析）",
    )
    drain3_match_score: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Drain3 模板匹配度 [0.0, 1.0]",
    )
    confidence: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="证据置信度 = 0.7 × match_score + 0.3 × source_prior",
    )
    is_grounded: bool = Field(
        default=False,
        description="是否通过溯源校验（Ground-Check 通过为 True）",
    )

    def compute_confidence(self, alpha: float = 0.7) -> float:
        """计算证据置信度。

        公式：confidence = α × drain3_match_score + (1-α) × source_prior

        Args:
            alpha: 模板匹配权重，默认 0.7（更信任可计算的模板匹配）

        Returns:
            置信度值 [0.0, 1.0]
        """
        prior = SOURCE_PRIOR.get(self.source, 0.50)
        return round(alpha * self.drain3_match_score + (1 - alpha) * prior, 4)


class Hypothesis(BaseModel):
    """因果推理假设。

    表示一个可能的根因假设，包含：
    - 假设描述
    - 支持证据 ID 列表
    - 置信度
    - 是否被排除
    - 排除理由（如被排除）
    """

    id: UUID = Field(default_factory=uuid4, description="假设唯一 ID")
    description: str = Field(description="假设描述，如'MySQL 慢查询导致 502'")
    supporting_evidence_ids: list[UUID] = Field(
        default_factory=list,
        description="支持该假设的证据 ID 列表",
    )
    confidence: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="假设置信度",
    )
    is_rejected: bool = Field(default=False, description="是否被排除")
    rejection_reason: str = Field(default="", description="排除理由")

    def reject(self, reason: str) -> None:
        """排除该假设并记录理由。"""
        self.is_rejected = True
        self.rejection_reason = reason


class RootCause(BaseModel):
    """根因分析结果。

    最终确定的根因，包含：
    - 根因描述
    - 支持证据链
    - 排除的假设列表
    - 综合置信度
    """

    description: str = Field(description="根因描述")
    evidence_chain: list[Evidence] = Field(
        default_factory=list,
        description="支持该根因的证据链",
    )
    rejected_hypotheses: list[Hypothesis] = Field(
        default_factory=list,
        description="考虑过但排除的假设",
    )
    confidence: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="综合置信度",
    )


# ============================================================
# 风险评估模型
# ============================================================


class RiskAssessment(BaseModel):
    """风险评估结果（4 层风险控制输出）。

    4 层风险控制：
    1. 语法检查：命令是否合法
    2. 风险评估：风险等级判定
    3. 证据展示 + 人工确认
    4. 审计日志
    """

    command: str = Field(description="待评估的命令")
    risk_level: RiskLevel = Field(description="风险等级")
    matched_rule_name: str = Field(
        default="",
        description="匹配到的规则名称",
    )
    requires_confirmation: bool = Field(
        default=False,
        description="是否需要人工确认",
    )
    requires_audit_log: bool = Field(
        default=False,
        description="是否需要审计日志",
    )
    is_irreversible: bool = Field(
        default=False,
        description="是否为不可逆操作",
    )
    syntax_valid: bool = Field(
        default=True,
        description="语法是否合法（第 1 层检查）",
    )
    syntax_error: str = Field(default="", description="语法错误描述")
    target_asset: str = Field(
        default="",
        description="目标资产名称（用于环境关键性判定）",
    )
    environment_criticality: str = Field(
        default="low",
        description="环境关键性：low / medium / high",
    )

    @property
    def adjusted_risk_level(self) -> RiskLevel:
        """根据环境关键性调整后的风险等级。

        若目标资产标记为「关键」，风险等级至少上调一档。
        """
        if self.environment_criticality == "high" and self.risk_level == RiskLevel.LOW:
            return RiskLevel.MEDIUM
        if self.environment_criticality == "high" and self.risk_level == RiskLevel.MEDIUM:
            return RiskLevel.HIGH
        return self.risk_level

    @property
    def l0_l4_level(self) -> str:
        """获取 spec 要求的 L0-L4 风险等级字符串。

        基于 adjusted_risk_level（已考虑环境关键性）转换。
        """
        return risk_level_to_l0_l4(self.adjusted_risk_level)

    @property
    def l0_l4_numeric(self) -> int:
        """获取 L0-L4 数值（用于权限融合矩阵比较）。"""
        return l0_l4_to_numeric(self.l0_l4_level)


# ============================================================
# 工厂函数
# ============================================================


def create_evidence(
    raw_text: str,
    source: EvidenceSource = EvidenceSource.UNKNOWN,
    source_file: str = "",
    line_number: int | None = None,
    drain3_match_score: float = 0.0,
    alpha: float = 0.7,
) -> Evidence:
    """创建证据实例并自动计算置信度。

    Args:
        raw_text: 证据原始文本
        source: 证据来源
        source_file: 来源文件路径
        line_number: 日志行号
        drain3_match_score: Drain3 模板匹配度
        alpha: 模板匹配权重（默认 0.7）

    Returns:
        带置信度的 Evidence 实例
    """
    evidence = Evidence(
        raw_text=raw_text,
        source=source,
        source_file=source_file,
        line_number=line_number,
        drain3_match_score=drain3_match_score,
    )
    evidence.confidence = evidence.compute_confidence(alpha)
    return evidence
