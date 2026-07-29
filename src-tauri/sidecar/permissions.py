"""
permissions.py — 4 档 × 3 mode 权限融合矩阵（T-P1-08.1）
============================================================

spec 要求（DEC-V321-01 权限融合模型）：
- **4 档风险**：L0（Safe）/ L1（Caution）/ L2（Warning）/ L3（Danger）/ L4（Critical）
- **3 模式**：plan（只读）/ agent（需审批）/ yolo（全自动）
- **融合规则**：
  - plan 模式：L0 静默，L1-L4 需审批（只读模式严格管控写操作）
  - agent 模式：L0-L1 静默，L2-L4 需审批
  - yolo 模式：L0-L2 静默，L3-L4 需审批（安全底线）
  - **L4 在任何模式下都不会自动 allow**（安全底线，必须人工审批）

设计要点：
1. 纯函数 + 不可变 dataclass，无副作用，便于测试
2. 不依赖其他 sidecar 模块（避免循环依赖）
3. 提供枚举 + dict 双接口（枚举便于类型检查，dict 便于 JSON 序列化）
4. 输入归一化：接受 str / Enum，统一转 Enum 处理
5. 错误优先：无效输入立即抛异常（fail-fast），不静默回退

返回值（PermissionDecision）：
- `allow`：自动允许执行
- `require_approval`：需要用户审批（前端弹 needs-you 卡片）
- `deny`：直接拒绝（当前 spec 场景未使用，保留用于未来扩展如「黑名单命令」）
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Final


# ============================================================================
# 枚举定义
# ============================================================================


class PermissionMode(str, Enum):
    """操作模式（3 档）

    与 AgentState.mode 字段对齐（graph/state.py）。

    语义：
    - PLAN:  只读模式，仅允许 L0 自动执行，其余均需审批（最严格）
    - AGENT: 智能代理模式，L0-L1 静默，L2-L4 需审批（默认模式）
    - YOLO:  全自动模式，L0-L2 静默，L3-L4 需审批（安全底线仍保留）
    """

    PLAN = "plan"
    AGENT = "agent"
    YOLO = "yolo"


class PermissionDecision(str, Enum):
    """权限决策（3 档）

    与 spec 行 209-214 对齐：
    - ALLOW:            自动允许执行
    - REQUIRE_APPROVAL: 需要用户审批（前端弹 needs-you 卡片）
    - DENY:             直接拒绝（保留，当前未使用）
    """

    ALLOW = "allow"
    REQUIRE_APPROVAL = "require_approval"
    DENY = "deny"


# ============================================================================
# 不可变结果对象
# ============================================================================


@dataclass(frozen=True)
class PermissionResult:
    """权限检查结果（不可变，便于缓存与并发传递）

    Attributes:
        decision:   决策结果（allow / require_approval / deny）
        reason:     决策理由（用于日志和 needs-you 卡片展示）
        mode:       操作模式
        risk_level: 风险等级（L0-L4 字符串）
    """

    decision: PermissionDecision
    reason: str
    mode: PermissionMode
    risk_level: str

    def to_dict(self) -> dict[str, str]:
        """转换为 dict（用于 JSON 序列化 / MCP tool 输出）

        Returns:
            dict 形式的权限检查结果
        """
        return {
            "decision": self.decision.value,
            "reason": self.reason,
            "mode": self.mode.value,
            "risk_level": self.risk_level,
        }


# ============================================================================
# 常量定义
# ============================================================================

# 合法风险等级集合
_VALID_RISK_LEVELS: Final[frozenset[str]] = frozenset({"L0", "L1", "L2", "L3", "L4"})

# 融合矩阵核心：每个 mode 对应「自动允许上限」
# 含义：risk_num <= auto_allow_max 时自动 allow
# - plan:  L0          （仅 Safe 静默）
# - agent: L0, L1      （Safe + Caution 静默）
# - yolo:  L0, L1, L2  （Safe + Caution + Warning 静默，但 L3/L4 仍审批）
_MODE_AUTO_ALLOW_MAX: Final[dict[PermissionMode, int]] = {
    PermissionMode.PLAN: 0,
    PermissionMode.AGENT: 1,
    PermissionMode.YOLO: 2,
}


# ============================================================================
# 输入归一化（内部工具函数）
# ============================================================================


def _normalize_mode(mode: str | PermissionMode) -> PermissionMode:
    """归一化 mode 输入

    Args:
        mode: 字符串（"plan" / "agent" / "yolo"，大小写不敏感）或 PermissionMode 枚举

    Returns:
        PermissionMode 枚举值

    Raises:
        TypeError:  类型不匹配
        ValueError: 字符串值不在合法范围内
    """
    if isinstance(mode, PermissionMode):
        return mode
    if isinstance(mode, str):
        normalized = mode.strip().lower()
        try:
            return PermissionMode(normalized)
        except ValueError as e:
            valid_modes = [m.value for m in PermissionMode]
            raise ValueError(
                f"invalid mode: '{mode}' (expected one of {valid_modes})"
            ) from e
    raise TypeError(
        f"mode must be str or PermissionMode, got {type(mode).__name__}"
    )


def _normalize_risk_level(risk_level: str) -> str:
    """归一化 risk_level 输入

    Args:
        risk_level: 风险等级字符串，接受以下形式（大小写不敏感）：
            - "L0" / "L1" / "L2" / "L3" / "L4"
            - "l0" / "l1" ...（小写）
            - "  L2  "（带空格）

    Returns:
        大写归一化后的 "L0" - "L4"

    Raises:
        TypeError:  类型不匹配
        ValueError: 字符串格式不正确或超出范围
    """
    if isinstance(risk_level, PermissionResult):  # 防误用
        raise TypeError("risk_level must be str, got PermissionResult")
    if not isinstance(risk_level, str):
        raise TypeError(
            f"risk_level must be str, got {type(risk_level).__name__}"
        )

    level = risk_level.strip().upper()
    if level not in _VALID_RISK_LEVELS:
        raise ValueError(
            f"invalid risk_level: '{risk_level}' (expected one of {sorted(_VALID_RISK_LEVELS)})"
        )
    return level


def _risk_level_to_num(risk_level: str) -> int:
    """L0 → 0, L1 → 1, ..., L4 → 4

    Args:
        risk_level: 已归一化的风险等级字符串

    Returns:
        0-4 整数
    """
    # 调用前应已通过 _normalize_risk_level 校验
    return int(risk_level[1:])


# ============================================================================
# 核心 API: check_permission
# ============================================================================


def check_permission(
    mode: str | PermissionMode,
    risk_level: str,
) -> PermissionResult:
    """4 档 × 3 mode 权限融合矩阵入口

    决策规则（spec DEC-V321-01）：

        | risk_level | plan  | agent | yolo  |
        |------------|-------|-------|-------|
        | L0 (Safe)  | allow | allow | allow |
        | L1 (Caution) | require_approval | allow | allow |
        | L2 (Warning) | require_approval | require_approval | allow |
        | L3 (Danger)  | require_approval | require_approval | require_approval |
        | L4 (Critical)| require_approval | require_approval | require_approval |

    注：L4 在所有模式下都需要审批（安全底线），不直接 deny（保留用户决策权）。

    Args:
        mode:       操作模式（"plan" / "agent" / "yolo"）
        risk_level: 风险等级（"L0" - "L4"）

    Returns:
        PermissionResult 不可变结果对象

    Raises:
        TypeError:  类型不匹配
        ValueError: mode 或 risk_level 无效

    Examples:
        >>> check_permission("agent", "L0").decision.value
        'allow'
        >>> check_permission("yolo", "L3").decision.value
        'require_approval'
        >>> check_permission("plan", "L1").decision.value
        'require_approval'
    """
    # 1. 输入归一化（fail-fast，无效输入立即抛异常）
    mode_enum = _normalize_mode(mode)
    normalized_level = _normalize_risk_level(risk_level)
    risk_num = _risk_level_to_num(normalized_level)

    # 2. 应用融合矩阵
    auto_allow_max = _MODE_AUTO_ALLOW_MAX[mode_enum]

    # 3. 决策：低于等于上限自动允许
    if risk_num <= auto_allow_max:
        return PermissionResult(
            decision=PermissionDecision.ALLOW,
            reason=(
                f"{mode_enum.value} 模式下 {normalized_level} 风险自动允许"
                f"（auto_allow_max=L{auto_allow_max}）"
            ),
            mode=mode_enum,
            risk_level=normalized_level,
        )

    # 4. 决策：超过上限需要审批（L4 也走此分支，不直接 deny）
    return PermissionResult(
        decision=PermissionDecision.REQUIRE_APPROVAL,
        reason=(
            f"{mode_enum.value} 模式下 {normalized_level} 风险需要用户审批"
            f"（auto_allow_max=L{auto_allow_max}）"
        ),
        mode=mode_enum,
        risk_level=normalized_level,
    )


def check_permission_dict(
    mode: str | PermissionMode,
    risk_level: str,
) -> dict[str, str]:
    """权限融合矩阵入口（dict 版本，便于 JSON 序列化）

    等价于 ``check_permission(mode, risk_level).to_dict()``，提供单独函数
    是为了方便直接嵌入 MCP tool / Tauri IPC 返回。

    Args:
        mode:       操作模式
        risk_level: 风险等级

    Returns:
        dict 形式的权限检查结果，字段：
        - decision:   "allow" / "require_approval" / "deny"
        - reason:     决策理由
        - mode:       归一化后的模式字符串
        - risk_level: 归一化后的风险等级字符串
    """
    return check_permission(mode, risk_level).to_dict()


# ============================================================================
# 查询辅助函数
# ============================================================================


def get_auto_allow_max(mode: str | PermissionMode) -> int:
    """获取指定模式下的自动允许上限（0-4）

    Args:
        mode: 操作模式

    Returns:
        0-4 整数（L0-L{n} 自动允许）

    Raises:
        TypeError:  类型不匹配
        ValueError: mode 无效
    """
    mode_enum = _normalize_mode(mode)
    return _MODE_AUTO_ALLOW_MAX[mode_enum]


def is_auto_allowed(mode: str | PermissionMode, risk_level: str) -> bool:
    """判断指定 mode + risk_level 是否自动允许

    Args:
        mode:       操作模式
        risk_level: 风险等级

    Returns:
        True 如果决策为 allow，False 否则
    """
    return check_permission(mode, risk_level).decision == PermissionDecision.ALLOW


def requires_approval(mode: str | PermissionMode, risk_level: str) -> bool:
    """判断指定 mode + risk_level 是否需要审批

    Args:
        mode:       操作模式
        risk_level: 风险等级

    Returns:
        True 如果决策为 require_approval，False 否则
    """
    return (
        check_permission(mode, risk_level).decision
        == PermissionDecision.REQUIRE_APPROVAL
    )


# ============================================================================
# 融合矩阵查询（用于文档展示 / UI 渲染 / 测试 fixture）
# ============================================================================


def get_fusion_matrix() -> dict[str, dict[str, str]]:
    """返回完整的融合矩阵（3 mode × 5 risk_level = 15 单元）

    用于：
    - 前端 UI 渲染权限矩阵表格
    - 文档自动生成
    - 测试 fixture 比对

    Returns:
        嵌套 dict，外层 key 为 mode，内层 key 为 risk_level，value 为决策字符串

    Example:
        >>> matrix = get_fusion_matrix()
        >>> matrix["agent"]["L2"]
        'require_approval'
        >>> matrix["yolo"]["L0"]
        'allow'
    """
    matrix: dict[str, dict[str, str]] = {}
    for mode_enum in PermissionMode:
        matrix[mode_enum.value] = {}
        for num in range(5):  # L0-L4
            level = f"L{num}"
            result = check_permission(mode_enum, level)
            matrix[mode_enum.value][level] = result.decision.value
    return matrix


def describe_fusion_matrix() -> str:
    """生成可读的融合矩阵描述（多行字符串，便于日志和文档）

    Returns:
        多行字符串，例如：
            Permission Fusion Matrix (4 risk × 3 mode):
            | Risk | plan  | agent | yolo  |
            |------|-------|-------|-------|
            | L0   | allow | allow | allow |
            | L1   | req.  | allow | allow |
            ...
    """
    matrix = get_fusion_matrix()
    lines = [
        "Permission Fusion Matrix (5 risk × 3 mode):",
        "| Risk | plan             | agent            | yolo             |",
        "|------|------------------|------------------|------------------|",
    ]
    for num in range(5):
        level = f"L{num}"
        row = f"| {level}  "
        for mode_value in ("plan", "agent", "yolo"):
            decision = matrix[mode_value][level]
            # 缩写：allow→allow, require_approval→req.
            short = "allow" if decision == "allow" else "req. "
            row += f"| {short:<16} "
        row += "|"
        lines.append(row)
    return "\n".join(lines)


# ============================================================================
# 模块导出
# ============================================================================


__all__ = [
    # 枚举
    "PermissionMode",
    "PermissionDecision",
    # 结果对象
    "PermissionResult",
    # 核心 API
    "check_permission",
    "check_permission_dict",
    # 辅助查询
    "get_auto_allow_max",
    "is_auto_allowed",
    "requires_approval",
    # 矩阵查询
    "get_fusion_matrix",
    "describe_fusion_matrix",
]


# ============================================================================
# 模块自检（python -m permissions 可直接打印矩阵）
# ============================================================================


if __name__ == "__main__":
    print(describe_fusion_matrix())
    print()
    print("Sample check_permission calls:")
    for m in ("plan", "agent", "yolo"):
        for r in ("L0", "L2", "L4"):
            result = check_permission(m, r)
            print(
                f"  check_permission('{m}', '{r}') = "
                f"{result.decision.value:<20} | {result.reason}"
            )
