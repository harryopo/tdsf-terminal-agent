"""
core/risk_engine.py — 4 层风险控制引擎（T-P1-06.2 迁移自 projects/src/tdsf/core/risk_engine.py）
====================================================================================================

迁移说明（用户决策④：仅复用 RiskEngine）：
- 完整保留原 4 层风控管道逻辑（语法检查 / 风险等级判定 / 确认要求 / 审计要求）
- 调整导入路径：tdsf.storage.schemas → core.schemas
- 通过 RiskAssessment.l0_l4_level 属性提供 L0-L4 风险等级（spec 要求）

实现方案书 4.4 节的风险控制体系：
1. 语法检查：命令是否合法
2. 风险评估：匹配风险规则库，判定风险等级
3. 证据展示 + 人工确认：中/高风险需人工确认
4. 审计日志：高风险操作记录审计日志

核心原则：
- 安全优先：未知命令默认中风险并要求人工确认
- deny 优先：deny 规则优先于 high/medium/low 判定
- 环境感知：目标资产关键性可上调风险等级
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

from core.schemas import RiskAssessment, RiskLevel


# ============================================================
# 风险规则数据模型
# ============================================================


class RiskRule(BaseModel):
    """单条风险规则。

    描述一类命令的风险特征，包含：
    - 名称与描述
    - 正则匹配模式列表（任一匹配即命中）
    - 是否需要人工确认
    - 是否需要审计日志
    - 是否为不可逆操作
    """

    name: str = Field(description="规则名称，如 rm_rf / systemctl_restart")
    description: str = Field(default="", description="规则描述")
    patterns: list[str] = Field(
        default_factory=list,
        description="正则匹配模式列表（re.match，从头匹配）",
    )
    requires_confirmation: bool = Field(
        default=False,
        description="是否需要人工确认",
    )
    requires_audit_log: bool = Field(
        default=False,
        description="是否需要审计日志",
    )
    irreversible: bool = Field(
        default=False,
        description="是否为不可逆操作",
    )


# ============================================================
# 风险控制引擎
# ============================================================

# YAML 键名到内部等级标签的映射
_KEY_MAP: dict[str, str] = {
    "low_risk": "low",
    "medium_risk": "medium",
    "high_risk": "high",
    "deny": "deny",
}

# 风险等级判定顺序：deny 最高优先级，low 最低
_LEVEL_ORDER: list[tuple[str, RiskLevel]] = [
    ("deny", RiskLevel.DENY),
    ("high", RiskLevel.HIGH),
    ("medium", RiskLevel.MEDIUM),
    ("low", RiskLevel.LOW),
]

# sudo 前缀剥离正则：匹配 `sudo` + 可选多个选项（如 -E / -u root / -i / -s）
# 设计要点：
# - ^sudo\s+ 必须以 sudo 开头（大小写不敏感）
# - (?:-\w+\s+(?:\S+\s+)?)* 匹配零个或多个「选项 + 可选参数」组合
#   - -E / -i / -s 等无参数选项：-\w+\s+
#   - -u root 等带参数选项：-\w+\s+\S+\s+
# - 用 count=1 防止误删命令内部
_SUDO_PREFIX_RE: re.Pattern[str] = re.compile(
    r"^sudo\s+(?:-\w+\s+(?:\S+\s+)?)*",
    re.IGNORECASE,
)


class RiskEngine:
    """4 层风险控制引擎。

    加载风险规则库（YAML）与资产关键性标签（YAML），
    对输入命令执行完整的 4 层风险评估并返回 RiskAssessment。

    4 层处理流程：
    1. 语法检查
    2. 风险等级判定
    3. 确认要求判定（中/高风险需确认，deny 不需确认）
    4. 审计要求判定（高风险需审计）
    最终根据目标资产关键性上调风险等级。
    """

    def __init__(self, risk_rules_path: str | Path, assets_path: str | Path) -> None:
        """初始化风险控制引擎，加载规则库与资产标签。

        Args:
            risk_rules_path: 风险规则库 YAML 路径。
            assets_path: 资产关键性标签 YAML 路径。
        """
        self._rules: dict[str, list[RiskRule]] = self._load_rules(risk_rules_path)
        self._assets: dict[str, str] = self._load_assets(assets_path)

    # ----------------------------------------------------------
    # 配置加载
    # ----------------------------------------------------------

    def _load_rules(self, path: str | Path) -> dict[str, list[RiskRule]]:
        """从 YAML 加载风险规则。

        Args:
            path: 风险规则库 YAML 路径。

        Returns:
            等级到规则列表的映射，如
            {'low': [...], 'medium': [...], 'high': [...], 'deny': [...]}
        """
        with open(path, encoding="utf-8") as f:
            raw: dict = yaml.safe_load(f) or {}

        rules: dict[str, list[RiskRule]] = {
            "low": [],
            "medium": [],
            "high": [],
            "deny": [],
        }
        for yaml_key, level in _KEY_MAP.items():
            raw_list: list[dict] = raw.get(yaml_key, []) or []
            for item in raw_list:
                rules[level].append(RiskRule(**item))
        return rules

    def _load_assets(self, path: str | Path) -> dict[str, str]:
        """从 YAML 加载资产关键性标签。

        Args:
            path: 资产配置 YAML 路径。

        Returns:
            资产名称到关键性的映射，如 {'demo-mysql': 'high', ...}
        """
        with open(path, encoding="utf-8") as f:
            raw: dict = yaml.safe_load(f) or {}

        assets: dict[str, str] = {}
        for item in raw.get("assets", []) or []:
            assets[item["name"]] = item.get("criticality", "low")
        return assets

    # ----------------------------------------------------------
    # 核心评估入口
    # ----------------------------------------------------------

    def assess(self, command: str, target_asset: str = "") -> RiskAssessment:
        """对命令执行完整 4 层风险评估（向后兼容入口）。

        等价于 ``assess_full_pipeline``，保留以兼容已有调用方。
        新代码建议直接使用 ``assess_full_pipeline`` 以凸显 4 层管道结构。

        Args:
            command: 待评估的命令文本。
            target_asset: 目标资产名称（用于环境关键性判定）。

        Returns:
            完整的 RiskAssessment 对象。
        """
        return self.assess_full_pipeline(command, target_asset=target_asset)

    # ----------------------------------------------------------
    # 4 层独立可配置接口（T-P5-04）
    # ----------------------------------------------------------

    def assess_layer1_syntax(self, command: str) -> tuple[bool, str]:
        """第 1 层：语法检查。

        验证命令基本合法性（空命令/特殊字符开头/连续特殊字符/疑似注入/括号不匹配）。

        独立调用：可不经过其他层直接检查命令语法。

        Args:
            command: 待检查的命令文本。

        Returns:
            (is_valid, error_message)，合法时 error_message 为空串。
        """
        return self._check_syntax(command)

    def assess_layer2_risk_level(
        self,
        command: str,
    ) -> tuple[RiskLevel, str, RiskRule | None]:
        """第 2 层：风险等级判定。

        按 deny -> high -> medium -> low 顺序匹配规则库。
        未匹配时默认 MEDIUM（安全优先）。

        独立调用：可仅判定风险等级，不触发确认/审计逻辑。

        Args:
            command: 待判定的命令文本。

        Returns:
            (risk_level, matched_rule_name, matched_rule)。
            未匹配任何规则时返回 (MEDIUM, "", None)。
        """
        return self._classify_risk(command)

    def assess_layer3_confirmation(
        self,
        rule: RiskRule | None,
        risk_level: RiskLevel,
    ) -> bool:
        """第 3 层：确认要求判定。

        规则：
        - DENY 等级：不需确认（不允许执行）
        - 匹配规则：使用 rule.requires_confirmation
        - 未匹配规则：默认需确认（安全优先）

        独立调用：可仅判定是否需要人工确认。

        Args:
            rule: 第 2 层返回的匹配规则（None 表示未匹配）。
            risk_level: 第 2 层返回的风险等级。

        Returns:
            是否需要人工确认。
        """
        # DENY 特殊处理：不允许执行，故不需确认
        if risk_level == RiskLevel.DENY:
            return False
        # 匹配到规则：使用规则配置
        if rule is not None:
            return bool(rule.requires_confirmation)
        # 未匹配规则：默认需确认（安全优先）
        return True

    def assess_layer4_audit(
        self,
        rule: RiskRule | None,
        risk_level: RiskLevel,
    ) -> bool:
        """第 4 层：审计要求判定。

        规则：
        - 匹配规则：使用 rule.requires_audit_log
        - 未匹配规则：不需审计（默认中风险命令无需审计）

        Note:
            与原 ``assess`` 行为保持一致：DENY 等级的审计要求由规则的
            ``requires_audit_log`` 字段决定，而非强制为 True。
            如需对 DENY 强制审计，可在 risk_rules.yaml 中为 deny 规则
            显式设置 ``requires_audit_log: true``。

        独立调用：可仅判定是否需要审计日志。

        Args:
            rule: 第 2 层返回的匹配规则（None 表示未匹配）。
            risk_level: 第 2 层返回的风险等级（保留参数以保持 4 层接口对称）。

        Returns:
            是否需要审计日志。
        """
        # 匹配到规则：使用规则配置
        if rule is not None:
            return bool(rule.requires_audit_log)
        # 未匹配规则：默认不需审计
        return False

    def assess_full_pipeline(
        self,
        command: str,
        target_asset: str = "",
    ) -> RiskAssessment:
        """4 层完整管道评估（与原 assess 行为一致）。

        处理流程：
        1. 第 1 层 assess_layer1_syntax → syntax_valid / syntax_error
        2. 第 2 层 assess_layer2_risk_level → risk_level / matched_rule_name / rule
        3. 第 3 层 assess_layer3_confirmation → requires_confirmation
        4. 第 4 层 assess_layer4_audit → requires_audit_log
        5. 不可逆标志：从 rule 继承，DENY 强制为 True
        6. 环境关键性标注

        与原 ``assess`` 行为完全一致（assess 内部直接调用本方法）。

        Args:
            command: 待评估的命令文本。
            target_asset: 目标资产名称（用于环境关键性判定）。

        Returns:
            完整的 RiskAssessment 对象。
        """
        # 第 1 层：语法检查
        syntax_valid, syntax_error = self.assess_layer1_syntax(command)

        # 第 2 层：风险等级判定（deny -> high -> medium -> low）
        risk_level, matched_rule_name, rule = self.assess_layer2_risk_level(command)

        # 第 3 层：确认要求
        requires_confirmation = self.assess_layer3_confirmation(rule, risk_level)

        # 第 4 层：审计要求
        requires_audit_log = self.assess_layer4_audit(rule, risk_level)

        # 不可逆标志：从 rule 继承，DENY 强制为 True
        is_irreversible: bool = bool(rule.irreversible) if rule is not None else False
        if risk_level == RiskLevel.DENY:
            is_irreversible = True

        # 环境关键性
        environment_criticality = self._get_environment_criticality(target_asset)

        return RiskAssessment(
            command=command,
            risk_level=risk_level,
            matched_rule_name=matched_rule_name,
            requires_confirmation=requires_confirmation,
            requires_audit_log=requires_audit_log,
            is_irreversible=is_irreversible,
            syntax_valid=syntax_valid,
            syntax_error=syntax_error,
            target_asset=target_asset,
            environment_criticality=environment_criticality,
        )

    # ----------------------------------------------------------
    # 第 1 层：语法检查
    # ----------------------------------------------------------

    def _check_syntax(self, command: str) -> tuple[bool, str]:
        """语法检查：验证命令基本合法性。

        检查项：
        - 空命令则失败
        - 以 & | ; 开头则失败（防止 shell 注入）
        - 包含 &&& 或 ||| 则失败（连续特殊字符）
        - 包含 ; rm 或 ;rm 则失败（疑似命令注入）
        - 圆括号不匹配则失败

        Args:
            command: 待检查的命令文本。

        Returns:
            (is_valid, error_message)，合法时 error_message 为空串。
        """
        stripped = command.strip()

        # 空命令
        if not stripped:
            return (False, "命令不能为空")

        # 以特殊字符开头（防止 shell 注入）
        if stripped[0] in "&|;":
            return (False, "命令不能以特殊字符开头")

        # 连续特殊字符
        if "&&&" in stripped or "|||" in stripped:
            return (False, "连续特殊字符")

        # 疑似命令注入
        if "; rm" in stripped or ";rm" in stripped:
            return (False, "疑似命令注入")

        # 括号匹配检查
        if not self._brackets_balanced(stripped):
            return (False, "括号不匹配")

        return (True, "")

    @staticmethod
    def _brackets_balanced(text: str) -> bool:
        """检查圆括号是否匹配。

        Args:
            text: 待检查的文本。

        Returns:
            括号匹配返回 True，否则 False。
        """
        depth = 0
        for char in text:
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
            if depth < 0:
                return False
        return depth == 0

    # ----------------------------------------------------------
    # 第 2 层：风险等级判定
    # ----------------------------------------------------------

    def _classify_risk(
        self,
        command: str,
    ) -> tuple[RiskLevel, str, RiskRule | None]:
        """风险等级判定：依次检查 deny -> high -> medium -> low。

        Args:
            command: 待判定的命令文本。

        Returns:
            (risk_level, matched_rule_name, matched_rule)。
            未匹配任何规则时返回 (MEDIUM, "", None)。

        Note:
            预处理阶段会剥离 ``sudo`` 前缀（含 ``sudo -E`` / ``sudo -u root``
            等变体），否则 ``sudo rm -rf /`` 不会命中 ``rm_root`` 规则
            （规则 patterns 要求 ``^rm`` 开头）。
        """
        # 预处理：剥离 sudo 前缀（含 sudo -E / sudo -u user 等变体）
        normalized_cmd = _SUDO_PREFIX_RE.sub("", command.strip(), count=1).strip()

        for level_key, risk_level in _LEVEL_ORDER:
            rule = self._match_command(normalized_cmd, self._rules.get(level_key, []))
            if rule is not None:
                return (risk_level, rule.name, rule)

        # 未匹配任何规则：默认中风险（安全优先）
        return (RiskLevel.MEDIUM, "", None)

    def _match_command(
        self,
        command: str,
        rules: list[RiskRule],
    ) -> RiskRule | None:
        """用 re.match 匹配命令，返回首个命中的规则。

        Args:
            command: 待匹配的命令文本。
            rules: 候选规则列表。

        Returns:
            首个匹配的规则，无匹配返回 None。
        """
        for rule in rules:
            for pattern in rule.patterns:
                if re.match(pattern, command):
                    return rule
        return None

    # ----------------------------------------------------------
    # 环境关键性
    # ----------------------------------------------------------

    def _get_environment_criticality(self, target_asset: str) -> str:
        """获取目标资产的关键性等级。

        Args:
            target_asset: 目标资产名称。

        Returns:
            关键性等级：low / medium / high。
            资产未指定或未找到时返回 low。
        """
        if not target_asset:
            return "low"
        return self._assets.get(target_asset, "low")


# ============================================================
# 模块级单例（懒加载，便于 T-P1-07 risk tool 调用）
# ============================================================

_engine_instance: RiskEngine | None = None


def get_risk_engine() -> RiskEngine:
    """获取全局 RiskEngine 实例（懒加载单例）。

    自动定位 config/risk_rules.yaml 和 config/assets.yaml。

    Returns:
        RiskEngine 实例
    """
    global _engine_instance
    if _engine_instance is None:
        from pathlib import Path
        # 定位 config 目录（python-sidecar/config/）
        config_dir = Path(__file__).parent.parent / "config"
        risk_rules_path = config_dir / "risk_rules.yaml"
        assets_path = config_dir / "assets.yaml"
        _engine_instance = RiskEngine(risk_rules_path, assets_path)
    return _engine_instance
