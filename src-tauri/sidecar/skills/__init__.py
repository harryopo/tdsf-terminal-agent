"""
skills — Skill 系统（T-P3-04 / T-P3-05 / T-P3-06 / T-P3-07）
================================================================

子模块：
- parser:       SKILL.md 解析器（YAML frontmatter + Markdown body）
- registry:     SkillRegistry（70+ Skill 注册 + 查询 + 调用）
- marketplace:  Skill 市场（skills.sh 协议 + 离线缓存）
- builtin/:     5 内置 Skill 的 SKILL.md 文件
    - linux-ops
    - ssh-troubleshoot
    - docker-management
    - selinux-baseline
    - python-debug

设计要点：
- Skill 是可执行的"专家技能"，封装了"何时使用 + 步骤 + 示例"
- 5 内置 Skill 通过 SKILL.md 文件定义（DEC-V321-13 标准）
- 65 外部 Skill 通过 mock 数据生成（模拟 claude-skills 库）
- MarketPlace 支持在线搜索 + 离线缓存（与爬虫降级策略一致）
"""

from __future__ import annotations

from skills.parser import Skill, parse_skill_md, parse_skill_content

__all__ = [
    "Skill",
    "parse_skill_md",
    "parse_skill_content",
]
