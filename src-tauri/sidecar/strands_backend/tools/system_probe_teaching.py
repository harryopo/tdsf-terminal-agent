"""Teaching-mode one-shot read-only environment probe.

教学开场专用：教学会话启动时由 Agent 自动调用一次，采集真实系统环境
（发行版/内核/主机名与登录身份/CPU/内存/根分区），Agent 基于结果开课。

这是教学模式唯一允许后端真实执行的通道——脚本固定只读、无参数、不
接受模型输入，因此不存在"代替学生做练习"的口子；此后所有教学步骤仍
必须通过命令卡由学生手动执行（或手输）。

不注册 shell 映射（registry 无 to_shell_command），因此不会被
wrap_tool_for_teach_mode 转成命令卡——这是设计使然，不是遗漏。
"""
from __future__ import annotations

from typing import Any

from strands_backend.tools import ToolContext, execute_via_ssh, tool

# 固定只读探测脚本：纯查询命令组合，无任何写操作/包管理/服务变更；
# 分节输出（--- 节名 ---）便于 Agent 逐段解读。
_PROBE_SCRIPT = (
    "cat /etc/os-release 2>/dev/null | head -5; "
    "echo '--- kernel ---'; uname -r; "
    "echo '--- host ---'; hostname; whoami; "
    "echo '--- cpu ---'; nproc; "
    "echo '--- mem ---'; free -h 2>/dev/null | head -2; "
    "echo '--- disk ---'; df -h / 2>/dev/null | tail -1"
)


def invoke_system_probe_teaching_tool(ctx: ToolContext) -> dict[str, Any]:
    """执行固定只读探测脚本（仅教学模式；一次性开场采集）"""
    if not getattr(ctx, "teach", False):
        return {
            "status": "system_probe_teaching_unavailable",
            "message": "系统环境探测仅在教学模式可用。",
        }
    # skip_approval：脚本固定只读且无参数（不接受模型输入），教学开场
    # 需要"自动执行、零打断"——豁免审批是本工具存在的意义，安全面可控。
    return execute_via_ssh(
        ctx,
        _PROBE_SCRIPT,
        timeout=20,
        tool_name="system_probe_teaching",
        explanation="教学开场：采集系统环境基线（只读）。",
        readonly=True,
        skip_approval=True,
    )


def make_system_probe_teaching_tool(ctx: ToolContext):
    """构建教学开场环境探测工具（带 ctx 闭包）

    Args:
        ctx: ToolContext 运行时上下文

    Returns:
        Strands @tool 装饰后的工具函数（Strands 不可用时为 passthrough 装饰）
    """
    @tool
    def system_probe_teaching() -> dict:
        """采集当前教学主机的系统环境基线（只读，一次性，自动执行）。

        教学开场时调用：采集发行版、内核版本、主机名与登录身份、CPU
        核数、内存、根分区占用。这是教学模式下唯一由系统自动执行的只读
        探测，学生无需操作；课程内容应基于真实结果展开。

        Returns:
            dict: status 取值 success | unavailable | error | command_blocked；
                output 为分节的原生终端输出，exit_code 为脚本退出码。
        """
        return invoke_system_probe_teaching_tool(ctx)

    system_probe_teaching.__name__ = "system_probe_teaching"
    return system_probe_teaching


__all__ = [
    "invoke_system_probe_teaching_tool",
    "make_system_probe_teaching_tool",
]
