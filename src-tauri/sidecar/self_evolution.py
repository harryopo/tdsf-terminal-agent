"""
self_evolution.py — KEPA 反向传播 + Skill 自动生成（T-P5-03）
==================================================================

职责：
- KEPAPropagator: 简化版反向传播（梯度下降），用于 Agent 自我进化
  - propagate(error, gradients): 应用误差缩放梯度
  - update_weights(weights, gradients, lr): 标准梯度下降更新权重
- SkillAutoGenerator: 从 Agent 执行历史自动生成 SKILL.md
  - analyze_history(history): 识别高频模式（命令/错误修复）
  - generate_skill(pattern): 生成 SKILL.md 内容（YAML frontmatter + Markdown body）
  - save_skill(name, content): 持久化到 skills/auto-generated/<name>/SKILL.md

设计要点：
- 全局开关：feature_flags.kepa.enabled + feature_flags.skill_auto_generate.enabled
- 关闭时 propagate/update_weights 走简化路径（返回输入，无操作）
- 关闭时 analyze_history 返回空模式、generate_skill 返回最小 SKILL.md
- 所有计算可离线运行（无外部 LLM 依赖）
- 自动生成的 Skill 与 builtin Skill 共享相同 SKILL.md 格式（DEC-V321-13 标准）

JSON-RPC 方法（main.py 注册）：
- kepa.propagate:       反向传播
- kepa.update_weights:  权重更新
- kepa.status:          查询 KEPA 开关状态
- skill.auto_generate:  从历史自动生成 Skill
- skill.list_auto:      列出已自动生成的 Skill
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger("sidecar.self_evolution")


# ============================================================
# 常量
# ============================================================

# 自动生成的 Skill 存放目录
_DEFAULT_AUTO_SKILLS_DIR: Path = (
    Path(__file__).parent / "skills" / "auto-generated"
)

# 默认配置文件路径
_DEFAULT_CONFIG_PATH: Path = Path(__file__).parent / "config" / "feature_flags.yaml"

# 默认学习率
_DEFAULT_LEARNING_RATE: float = 0.01

# 默认触发自动生成的最小模式频次
_DEFAULT_MIN_PATTERN_FREQUENCY: int = 3

# Skill 名称合法字符（仅 a-z 0-9 - _）
_SKILL_NAME_SAFE_RE: re.Pattern[str] = re.compile(r"[^a-z0-9\-_]+")


# ============================================================
# KEPAPropagator — 反向传播简化版
# ============================================================


class KEPAPropagator:
    """KEPA 反向传播器（Knowledge Evolution via Propagation Algorithm）。

    简化版梯度下降：
    - propagate(error, gradients): 用误差缩放梯度
        updated_gradients[k] = gradients[k] * error
    - update_weights(weights, gradients, lr): 标准梯度下降
        updated_weights[k] = weights[k] - lr * gradients[k]

    用法：
        propagator = KEPAPropagator(enabled=True)
        grads = propagator.propagate(0.5, {"tool_a": 0.2, "tool_b": -0.1})
        new_weights = propagator.update_weights(
            weights={"tool_a": 1.0, "tool_b": 0.5},
            gradients=grads,
            lr=0.01,
        )

    Args:
        enabled: 是否启用 KEPA（关闭时所有方法走简化路径）
        learning_rate: 默认学习率（0~1）
    """

    def __init__(
        self,
        enabled: bool = False,
        learning_rate: float = _DEFAULT_LEARNING_RATE,
    ) -> None:
        """初始化 KEPAPropagator。

        Args:
            enabled: 是否启用 KEPA
            learning_rate: 默认学习率（建议 0.001~0.1）
        """
        self.enabled: bool = enabled
        self.learning_rate: float = float(learning_rate)
        logger.info(
            f"KEPAPropagator initialized: enabled={enabled}, "
            f"learning_rate={self.learning_rate}"
        )

    # ----------------------------------------------------------
    # propagate — 误差缩放梯度
    # ----------------------------------------------------------

    def propagate(
        self,
        error: float,
        gradients: dict[str, float],
    ) -> dict[str, float]:
        """用误差缩放梯度（反向传播的简化版）。

        公式（enabled=True）：
            updated_gradients[k] = gradients[k] * error

        公式（enabled=False）：
            updated_gradients[k] = gradients[k]（原样返回）

        Args:
            error: 误差标量（可为负数，表示预测偏低）
            gradients: 待缩放的梯度字典（key → 梯度值）

        Returns:
            缩放后的梯度字典（key → 缩放后的梯度值）
        """
        if not gradients:
            return {}

        # 关闭状态 → 原样返回（无操作）
        if not self.enabled:
            return dict(gradients)

        # 启用状态 → 误差缩放
        return {k: float(v) * float(error) for k, v in gradients.items()}

    # ----------------------------------------------------------
    # update_weights — 标准梯度下降
    # ----------------------------------------------------------

    def update_weights(
        self,
        weights: dict[str, float],
        gradients: dict[str, float],
        lr: float = 0.0,
    ) -> dict[str, float]:
        """标准梯度下降更新权重。

        公式（enabled=True）：
            updated_weights[k] = weights[k] - lr * gradients[k]
            （仅对同时出现在 weights 和 gradients 中的 key 更新）

        公式（enabled=False）：
            updated_weights[k] = weights[k]（原样返回）

        Args:
            weights: 当前权重字典
            gradients: 梯度字典（来自 propagate）
            lr: 学习率。0 时使用 self.learning_rate

        Returns:
            更新后的权重字典
        """
        if not weights:
            return {}

        # 关闭状态 → 原样返回
        if not self.enabled:
            return dict(weights)

        effective_lr: float = float(lr) if lr > 0 else self.learning_rate
        updated: dict[str, float] = dict(weights)
        for key, grad in gradients.items():
            if key in updated:
                updated[key] = float(updated[key]) - effective_lr * float(grad)
        return updated

    # ----------------------------------------------------------
    # 元数据
    # ----------------------------------------------------------

    def status(self) -> dict[str, Any]:
        """返回当前状态（供 JSON-RPC kepa.status）"""
        return {
            "enabled": self.enabled,
            "learning_rate": self.learning_rate,
        }


# ============================================================
# SkillAutoGenerator — 从历史自动生成 Skill
# ============================================================


@dataclass
class SkillPattern:
    """从历史中识别出的 Skill 模式。

    Attributes:
        pattern: 模式标识（如命令文本、错误类型）
        frequency: 出现次数
        examples: 示例列表（最多 5 条）
        category: 模式类别（command / error / workflow）
    """

    pattern: str
    frequency: int = 0
    examples: list[str] = field(default_factory=list)
    category: str = "command"

    def to_dict(self) -> dict[str, Any]:
        """序列化为 JSON 兼容字典"""
        return {
            "pattern": self.pattern,
            "frequency": self.frequency,
            "examples": list(self.examples),
            "category": self.category,
        }


class SkillAutoGenerator:
    """从 Agent 执行历史自动生成 SKILL.md。

    流程：
    1. analyze_history(history) → 识别高频模式（命令/错误）
    2. generate_skill(pattern) → 生成 SKILL.md 内容
    3. save_skill(name, content) → 持久化到磁盘

    用法：
        gen = SkillAutoGenerator(enabled=True, min_frequency=3)
        analysis = gen.analyze_history(history_records)
        for pattern in analysis["patterns"]:
            content = gen.generate_skill(pattern)
            path = gen.save_skill(pattern["pattern"], content)

    Args:
        enabled: 是否启用 Skill 自动生成
        min_frequency: 触发生成的最小模式频次（默认 3）
        output_dir: 自动生成 Skill 的输出目录
    """

    def __init__(
        self,
        enabled: bool = False,
        min_frequency: int = _DEFAULT_MIN_PATTERN_FREQUENCY,
        output_dir: Path | str | None = None,
    ) -> None:
        """初始化 SkillAutoGenerator。

        Args:
            enabled: 是否启用
            min_frequency: 触发生成的最小模式频次
            output_dir: 输出目录。None 时使用 _DEFAULT_AUTO_SKILLS_DIR
        """
        self.enabled: bool = enabled
        self.min_frequency: int = max(1, int(min_frequency))
        self.output_dir: Path = (
            Path(output_dir) if output_dir else _DEFAULT_AUTO_SKILLS_DIR
        )
        logger.info(
            f"SkillAutoGenerator initialized: enabled={enabled}, "
            f"min_frequency={self.min_frequency}, output_dir={self.output_dir}"
        )

    # ----------------------------------------------------------
    # analyze_history — 识别高频模式
    # ----------------------------------------------------------

    def analyze_history(self, history: list[dict]) -> dict[str, Any]:
        """从 Agent 执行历史中识别高频模式。

        历史记录格式（每条 dict）：
            {
                "command": "systemctl restart nginx",  # 可选
                "error": "Address already in use",      # 可选
                "tool": "shell",                        # 可选
                "agent": "coding",                      # 可选
                "success": True,                        # 可选
            }

        Args:
            history: 历史记录列表

        Returns:
            分析结果 dict：
            {
                "patterns": [SkillPattern.to_dict(), ...],  # 高频模式列表
                "total_history": int,                       # 历史总条数
                "analyzed_patterns": int,                   # 已分析的独立模式数
                "generated_count": int,                     # 满足频次阈值的模式数
            }
        """
        if not history:
            return {
                "patterns": [],
                "total_history": 0,
                "analyzed_patterns": 0,
                "generated_count": 0,
            }

        # 统计命令频次
        command_counter: Counter[str] = Counter()
        command_examples: dict[str, list[str]] = {}
        error_counter: Counter[str] = Counter()
        error_examples: dict[str, list[str]] = {}

        for record in history:
            if not isinstance(record, dict):
                continue
            # 提取命令
            cmd: str = str(record.get("command", "")).strip()
            if cmd:
                command_counter[cmd] += 1
                if cmd not in command_examples:
                    command_examples[cmd] = []
                if len(command_examples[cmd]) < 5:
                    # 附加上下文信息（tool / agent / success）
                    tool: str = str(record.get("tool", ""))
                    agent: str = str(record.get("agent", ""))
                    success: bool = bool(record.get("success", True))
                    command_examples[cmd].append(
                        f"tool={tool} agent={agent} success={success}"
                    )
            # 提取错误
            err: str = str(record.get("error", "")).strip()
            if err:
                error_counter[err] += 1
                if err not in error_examples:
                    error_examples[err] = []
                if len(error_examples[err]) < 5:
                    error_examples[err].append(cmd or "(no command)")

        # 关闭状态 → 返回统计但不报告模式（避免误触发生成）
        if not self.enabled:
            return {
                "patterns": [],
                "total_history": len(history),
                "analyzed_patterns": len(command_counter) + len(error_counter),
                "generated_count": 0,
            }

        # 启用状态 → 筛选高频模式
        patterns: list[SkillPattern] = []

        # 高频命令模式
        for cmd, freq in command_counter.most_common():
            if freq >= self.min_frequency:
                patterns.append(
                    SkillPattern(
                        pattern=cmd,
                        frequency=freq,
                        examples=command_examples.get(cmd, []),
                        category="command",
                    )
                )

        # 高频错误模式
        for err, freq in error_counter.most_common():
            if freq >= self.min_frequency:
                patterns.append(
                    SkillPattern(
                        pattern=err,
                        frequency=freq,
                        examples=error_examples.get(err, []),
                        category="error",
                    )
                )

        return {
            "patterns": [p.to_dict() for p in patterns],
            "total_history": len(history),
            "analyzed_patterns": len(command_counter) + len(error_counter),
            "generated_count": len(patterns),
        }

    # ----------------------------------------------------------
    # generate_skill — 生成 SKILL.md 内容
    # ----------------------------------------------------------

    def generate_skill(self, pattern: dict) -> str:
        """根据模式生成 SKILL.md 内容。

        生成的 SKILL.md 遵循 DEC-V321-13 标准（与 builtin Skill 同格式）：
        - YAML frontmatter（name/description/version/author/tags）
        - Markdown body（When to use / Steps / Examples）

        Args:
            pattern: 模式 dict（SkillPattern.to_dict() 格式）
                {
                    "pattern": "systemctl restart nginx",
                    "frequency": 5,
                    "examples": ["tool=shell agent=coding success=True", ...],
                    "category": "command",  # 或 "error"
                }

        Returns:
            SKILL.md 内容字符串
        """
        if not pattern or not isinstance(pattern, dict):
            return self._minimal_skill_md()

        pattern_text: str = str(pattern.get("pattern", "")).strip()
        if not pattern_text:
            return self._minimal_skill_md()

        frequency: int = int(pattern.get("frequency", 0))
        examples: list[str] = list(pattern.get("examples", []))
        category: str = str(pattern.get("category", "command"))

        # 生成 Skill 名称（仅 a-z 0-9 - _）
        skill_name: str = self._sanitize_skill_name(pattern_text)

        # 描述
        description: str = (
            f"Auto-generated Skill for {category} '{pattern_text[:50]}' "
            f"(observed {frequency} times)"
        )

        # Tags
        tags: list[str] = ["auto-generated", category]
        if frequency >= 10:
            tags.append("high-frequency")

        # When to use
        when_to_use: str = self._build_when_to_use(pattern_text, category, frequency)

        # Steps
        steps: str = self._build_steps(pattern_text, category, examples)

        # Examples
        examples_section: str = self._build_examples(pattern_text, examples)

        # 组装 SKILL.md
        frontmatter: dict[str, Any] = {
            "name": skill_name,
            "description": description,
            "version": "0.1.0",
            "author": "TDSF-AutoGen",
            "tags": tags,
        }
        yaml_front: str = yaml.safe_dump(frontmatter, allow_unicode=True, sort_keys=False).strip()
        body: str = (
            f"# {skill_name}\n\n"
            f"## When to use\n\n{when_to_use}\n\n"
            f"## Steps\n\n{steps}\n\n"
            f"## Examples\n\n{examples_section}\n"
        )
        return f"---\n{yaml_front}\n---\n\n{body}"

    # ----------------------------------------------------------
    # save_skill — 持久化到磁盘
    # ----------------------------------------------------------

    def save_skill(self, name: str, content: str) -> Path:
        """保存 SKILL.md 到磁盘。

        保存路径：<output_dir>/<sanitized_name>/SKILL.md

        Args:
            name: Skill 名称（会自动 sanitize）
            content: SKILL.md 内容

        Returns:
            保存的文件路径
        """
        safe_name: str = self._sanitize_skill_name(name)
        if not safe_name:
            safe_name = "unnamed-skill"

        skill_dir: Path = self.output_dir / safe_name
        skill_dir.mkdir(parents=True, exist_ok=True)
        skill_path: Path = skill_dir / "SKILL.md"
        skill_path.write_text(content, encoding="utf-8")
        logger.info(f"Skill saved: {skill_path}")
        return skill_path

    # ----------------------------------------------------------
    # list_auto_skills — 列出已自动生成的 Skill
    # ----------------------------------------------------------

    def list_auto_skills(self) -> list[dict[str, Any]]:
        """列出 output_dir 下已自动生成的 Skill。

        Returns:
            list[dict]：每个元素为 {"name": str, "path": str}
        """
        if not self.output_dir.exists():
            return []
        result: list[dict[str, Any]] = []
        for child in self.output_dir.iterdir():
            if child.is_dir():
                skill_md: Path = child / "SKILL.md"
                if skill_md.exists():
                    result.append(
                        {"name": child.name, "path": str(skill_md)}
                    )
        return sorted(result, key=lambda x: x["name"])

    # ----------------------------------------------------------
    # 内部辅助函数
    # ----------------------------------------------------------

    def _sanitize_skill_name(self, raw: str) -> str:
        """将任意字符串转为合法 Skill 名称（小写 + 连字符）。

        Args:
            raw: 原始字符串（可能含空格/特殊字符/中文）

        Returns:
            合法的 Skill 名称（仅 a-z 0-9 - _）
        """
        # 转小写
        s: str = raw.lower().strip()
        # 替换空格为连字符
        s = re.sub(r"\s+", "-", s)
        # 移除不合法字符
        s = _SKILL_NAME_SAFE_RE.sub("-", s)
        # 合并连续连字符
        s = re.sub(r"-+", "-", s)
        # 去除首尾连字符
        s = s.strip("-_")
        # 限制长度（避免文件名过长）
        if len(s) > 60:
            s = s[:60].rstrip("-_")
        return s or "unnamed"

    def _minimal_skill_md(self) -> str:
        """返回最小化的 SKILL.md（空 pattern 兜底）"""
        return (
            "---\n"
            "name: unnamed-auto-skill\n"
            "description: Auto-generated Skill (no pattern)\n"
            "version: 0.1.0\n"
            "author: TDSF-AutoGen\n"
            "tags: [auto-generated]\n"
            "---\n\n"
            "# Unnamed Auto Skill\n\n"
            "## When to use\n\n(无可用模式)\n\n"
            "## Steps\n\n1. (待补充)\n\n"
            "## Examples\n\n(无)\n"
        )

    def _build_when_to_use(self, pattern: str, category: str, frequency: int) -> str:
        """构建 When to use 章节"""
        if category == "error":
            return (
                f"- 用户遇到错误：`{pattern}`\n"
                f"- 该错误在历史中出现 {frequency} 次，建议参考本 Skill 的修复步骤\n"
                f"- 触发关键词：{pattern}"
            )
        return (
            f"- 用户请求执行命令：`{pattern}`\n"
            f"- 该命令在历史中出现 {frequency} 次，已沉淀为可复用 Skill\n"
            f"- 触发关键词：{pattern}"
        )

    def _build_steps(self, pattern: str, category: str, examples: list[str]) -> str:
        """构建 Steps 章节"""
        if category == "error":
            return (
                f"1. **复现错误**：执行 `{pattern}` 确认错误现象\n"
                f"2. **根因分析**：根据错误信息定位问题（端口冲突/权限/配置等）\n"
                f"3. **修复**：根据根因采取对应修复措施\n"
                f"4. **验证**：再次执行 `{pattern}` 确认错误已消除\n"
                f"5. **持久化**：将修复应用到配置文件或 systemd unit"
            )
        return (
            f"1. **风险评估**：调用 `risk` tool 评估 `{pattern}` 的风险等级\n"
            f"2. **执行命令**：根据评估结果直接执行或申请审批\n"
            f"3. **验证结果**：检查命令退出码 + 输出\n"
            f"4. **持久化**：如需重启服务或保存配置，执行对应操作"
        )

    def _build_examples(self, pattern: str, examples: list[str]) -> str:
        """构建 Examples 章节"""
        if not examples:
            return f"```\n用户: 执行 {pattern}\nAgent: 已自动执行（参考 Steps）\n```"
        lines: list[str] = ["```"]
        for i, ex in enumerate(examples[:5], start=1):
            lines.append(f"历史记录 {i}: {ex}")
        lines.append("```")
        return "\n".join(lines)

    # ----------------------------------------------------------
    # 元数据
    # ----------------------------------------------------------

    def status(self) -> dict[str, Any]:
        """返回当前状态（供 JSON-RPC skill.status）"""
        return {
            "enabled": self.enabled,
            "min_frequency": self.min_frequency,
            "output_dir": str(self.output_dir),
            "auto_skills_count": len(self.list_auto_skills()),
        }


# ============================================================
# 模块级单例（懒加载，基于 feature flags 配置）
# ============================================================

_kepa_instance: KEPAPropagator | None = None
_generator_instance: SkillAutoGenerator | None = None


def get_kepa() -> KEPAPropagator:
    """获取全局 KEPAPropagator 单例（基于 feature flags 配置）。

    Returns:
        KEPAPropagator 实例
    """
    global _kepa_instance
    if _kepa_instance is None:
        # 延迟导入避免循环依赖
        from long_context import get_feature_flags

        flags = get_feature_flags()
        _kepa_instance = KEPAPropagator(
            enabled=flags.kepa_enabled,
            learning_rate=flags.kepa_learning_rate,
        )
    return _kepa_instance


def get_skill_generator() -> SkillAutoGenerator:
    """获取全局 SkillAutoGenerator 单例（基于 feature flags 配置）。

    Returns:
        SkillAutoGenerator 实例
    """
    global _generator_instance
    if _generator_instance is None:
        from long_context import get_feature_flags

        flags = get_feature_flags()
        _generator_instance = SkillAutoGenerator(
            enabled=flags.skill_auto_generate_enabled,
            min_frequency=flags.skill_auto_generate_min_frequency,
        )
    return _generator_instance


def reset_instances() -> None:
    """重置全局单例（仅供测试使用）"""
    global _kepa_instance, _generator_instance
    _kepa_instance = None
    _generator_instance = None


# ============================================================
# JSON-RPC 方法注册
# ============================================================


def register_methods(dispatcher: Any) -> None:
    """向 JSON-RPC dispatcher 注册 kepa.* 和 skill.auto_* 方法

    注册的方法：
    - kepa.propagate:       反向传播
    - kepa.update_weights:  权重更新
    - kepa.status:          查询 KEPA 状态
    - skill.auto_generate:  从历史自动生成 Skill
    - skill.list_auto:      列出已自动生成的 Skill
    - skill.status:         查询 Skill 生成器状态
    """

    def _kepa_propagate(
        error: float,
        gradients: dict[str, float],
    ) -> dict[str, Any]:
        """JSON-RPC: kepa.propagate"""
        propagator: KEPAPropagator = get_kepa()
        updated: dict[str, float] = propagator.propagate(error, gradients)
        return {
            "updated_gradients": updated,
            "error": float(error),
            "enabled": propagator.enabled,
        }

    def _kepa_update_weights(
        weights: dict[str, float],
        gradients: dict[str, float],
        lr: float = 0.0,
    ) -> dict[str, Any]:
        """JSON-RPC: kepa.update_weights"""
        propagator = get_kepa()
        updated_weights: dict[str, float] = propagator.update_weights(
            weights, gradients, lr=lr
        )
        return {
            "updated_weights": updated_weights,
            "lr": float(lr) if lr > 0 else propagator.learning_rate,
            "enabled": propagator.enabled,
        }

    def _kepa_status() -> dict[str, Any]:
        """JSON-RPC: kepa.status"""
        return get_kepa().status()

    def _skill_auto_generate(history: list[dict]) -> dict[str, Any]:
        """JSON-RPC: skill.auto_generate

        从历史记录分析高频模式并自动生成 SKILL.md
        """
        gen: SkillAutoGenerator = get_skill_generator()
        analysis: dict[str, Any] = gen.analyze_history(history)
        generated: list[dict[str, Any]] = []
        for pattern in analysis.get("patterns", []):
            content: str = gen.generate_skill(pattern)
            path: Path = gen.save_skill(pattern.get("pattern", "unnamed"), content)
            generated.append(
                {
                    "name": pattern.get("pattern", ""),
                    "path": str(path),
                    "frequency": pattern.get("frequency", 0),
                    "category": pattern.get("category", "command"),
                }
            )
        return {
            "analysis": analysis,
            "generated": generated,
            "generated_count": len(generated),
            "enabled": gen.enabled,
        }

    def _skill_list_auto() -> dict[str, Any]:
        """JSON-RPC: skill.list_auto"""
        gen = get_skill_generator()
        return {"skills": gen.list_auto_skills()}

    def _skill_status() -> dict[str, Any]:
        """JSON-RPC: skill.status"""
        return get_skill_generator().status()

    dispatcher.register("kepa.propagate", _kepa_propagate)
    dispatcher.register("kepa.update_weights", _kepa_update_weights)
    dispatcher.register("kepa.status", _kepa_status)
    dispatcher.register("skill.auto_generate", _skill_auto_generate)
    dispatcher.register("skill.list_auto", _skill_list_auto)
    dispatcher.register("skill.status", _skill_status)
    logger.info(
        "kepa.* + skill.auto_* methods registered (6 methods)"
    )
