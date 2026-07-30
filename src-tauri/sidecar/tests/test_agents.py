"""
tests/test_agents.py — Agent 框架单元测试（T-P1-11.5 + T-P4-01 扩展）
=========================================================================

验证内容：
1. BaseAgent（base.py）
   - 初始化（name/role/tools/event_bus/llm_call）
   - invoke() 模板方法流程（PAOR 单轮）
   - call_llm() 真实调用 + mock 回退
   - call_tool() 工具调用（成功 + 失败）
   - _emit_mood / _emit_message 事件推送
   - build_system_prompt() TDSF 后缀拼接
   - get_stats() 统计

2. MainAgent（main_agent.py）
   - plan_task() 9 类任务规划（教学/探索/历史/编码/调试/重构/测试/部署/运维）
   - _parse_task_prefix() 前缀解析（含 4 个 P4 新前缀）
   - invoke() PAOR 监督 + 子 Agent 路由
   - 复合任务多步执行

3. CodingAgent（coding_agent.py）
   - plan_task() 编码任务规划
   - select_tool() 工具选择（risk/decision/confidence）
   - format_observation() 风险/决策/置信度格式化

4. ExploreAgent（explore_agent.py）
   - plan_task() 探索任务规划
   - select_tool() ground/history/credibility 选择

5. HistoryAgent（history_agent.py）
   - plan_task() 历史任务规划
   - compress_context() 上下文压缩

6. TeachAgent（teach_agent.py）
   - plan_task() 教学任务规划
   - _generate_teaching_content() 教学内容生成
   - _mock_teaching_content() mock 模板
   - _extract_command_name() 命令名提取

7. DebugAgent / RefactorAgent / TestAgent / DeployAgent（T-P4-01 新增）
   - 初始化（name/role/tools）
   - plan_task() 各自任务规划
   - _parse_task_prefix() 支持 4 新前缀

8. AGENT_REGISTRY + 全局配置
   - 注册表完整性（9 个 Agent，P4 扩展）
   - configure_agents() 全局配置
   - get_agent() / invoke_agent()
   - reset_for_test() 测试隔离
   - JSON-RPC 方法注册

运行：
    cd python-sidecar
    python -m pytest tests/test_agents.py -v
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

# 确保能 import agents
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from agents.base import BaseAgent, AgentResult
from agents.main_agent import MainAgent
from agents.coding_agent import CodingAgent
from agents.explore_agent import ExploreAgent
from agents.history_agent import HistoryAgent
from agents.teach_agent import TeachAgent
# T-P4-01: 新增 4 子 Agent
from agents.debug_agent import DebugAgent
from agents.refactor_agent import RefactorAgent
from agents.test_agent import TestAgent
from agents.deploy_agent import DeployAgent
from agents import (
    AGENT_REGISTRY,
    configure_agents,
    get_agent,
    list_agents,
    invoke_agent,
    register_methods,
    reset_for_test,
    set_backend,
    clear_backend,
)


# ============================================================================
# Fixture
# ============================================================================

@pytest.fixture(autouse=True)
def reset_agents_state():
    """每个测试前后重置 agents 全局状态"""
    reset_for_test()
    yield
    reset_for_test()


@pytest.fixture
def mock_event_bus():
    """Mock EventBus"""
    bus = MagicMock()
    bus.publish = MagicMock()
    return bus


@pytest.fixture
def mock_llm_call():
    """Mock LLM 调用函数"""
    def _call(messages):
        # 返回基于最后一条 user 消息的简单响应
        for msg in reversed(messages):
            if msg.get("role") == "user":
                return f"LLM response for: {msg.get('content', '')[:50]}"
        return "LLM response"
    return _call


@pytest.fixture
def configured_agents(mock_event_bus, mock_llm_call):
    """已配置的 Agent 集合"""
    configure_agents(event_bus=mock_event_bus, llm_call=mock_llm_call)
    return mock_event_bus


# ============================================================================
# 1. BaseAgent 测试
# ============================================================================

class TestBaseAgentInit:
    """BaseAgent 初始化测试"""

    def test_init_basic_attributes(self, mock_event_bus):
        """初始化基础属性"""
        agent = BaseAgent(
            name="test",
            role="测试 Agent",
            description="测试用",
            tools=["risk", "ground"],
            event_bus=mock_event_bus,
        )
        assert agent.name == "test"
        assert agent.role == "测试 Agent"
        assert agent.tools == ["risk", "ground"]
        assert agent.event_bus is mock_event_bus
        assert agent.llm_call is None

    def test_init_without_event_bus(self):
        """无 event_bus 初始化（离线测试场景）"""
        agent = BaseAgent(
            name="test",
            role="测试",
            description="",
            tools=[],
        )
        assert agent.event_bus is None

    def test_init_stats_initialized(self, mock_event_bus):
        """统计字段初始化"""
        agent = BaseAgent(
            name="test", role="", description="",
            tools=[], event_bus=mock_event_bus,
        )
        stats = agent.get_stats()
        assert stats["invocations"] == 0
        assert stats["tool_calls"] == 0
        assert stats["errors"] == 0
        assert stats["total_duration"] == 0.0
        assert stats["avg_duration"] == 0.0


class TestBaseAgentInvoke:
    """BaseAgent.invoke() 模板方法测试"""

    def test_invoke_returns_state_update(self, mock_event_bus):
        """invoke 应返回部分状态更新 dict"""
        agent = BaseAgent(
            name="test", role="测试", description="",
            tools=[], event_bus=mock_event_bus,
        )
        state = {
            "input": "测试输入",
            "session_id": "sess-1",
            "iteration": 0,
            "current_task": "测试任务",
        }
        update = agent.invoke(state)
        assert isinstance(update, dict)
        assert "observation" in update
        assert "next_step" in update
        assert "mood" in update

    def test_invoke_increments_stats(self, mock_event_bus):
        """invoke 应增加 invocations 统计"""
        agent = BaseAgent(
            name="test", role="", description="",
            tools=[], event_bus=mock_event_bus,
        )
        state = {"input": "测试", "session_id": "", "iteration": 0}
        agent.invoke(state)
        agent.invoke(state)
        assert agent.get_stats()["invocations"] == 2

    def test_invoke_emits_mood_events(self, mock_event_bus):
        """invoke 应推送 mood 事件"""
        agent = BaseAgent(
            name="test", role="", description="",
            tools=[], event_bus=mock_event_bus,
        )
        state = {"input": "测试", "session_id": "sess-1", "iteration": 0}
        agent.invoke(state)
        # 应至少推送 thinking 和 done 两个 mood 事件
        assert mock_event_bus.publish.call_count >= 2

    def test_invoke_with_error_returns_error_state(self, mock_event_bus):
        """invoke 出错应返回 error 状态"""
        agent = BaseAgent(
            name="test", role="", description="",
            tools=[], event_bus=mock_event_bus,
        )
        # 让 plan_task 抛异常
        agent.plan_task = MagicMock(side_effect=RuntimeError("test error"))
        state = {"input": "测试", "session_id": "", "iteration": 0}
        update = agent.invoke(state)
        assert update["next_step"] == "error"
        assert update["mood"] == "error"
        assert "test error" in update["error"]
        assert agent.get_stats()["errors"] == 1


class TestBaseAgentLLMCall:
    """BaseAgent.call_llm() 测试"""

    def test_call_llm_with_injected_function(self, mock_event_bus, mock_llm_call):
        """注入 llm_call 时应调用它"""
        agent = BaseAgent(
            name="test", role="", description="",
            tools=[], event_bus=mock_event_bus, llm_call=mock_llm_call,
        )
        messages = [{"role": "user", "content": "hello"}]
        result = agent.call_llm(messages)
        assert "hello" in result
        assert agent.get_stats()["llm_calls"] == 1

    def test_call_llm_fallback_to_mock(self, mock_event_bus):
        """未注入 llm_call 时使用 mock"""
        agent = BaseAgent(
            name="test", role="", description="",
            tools=[], event_bus=mock_event_bus,
        )
        messages = [{"role": "user", "content": "world"}]
        result = agent.call_llm(messages)
        assert "[mock-llm]" in result
        assert "world" in result

    def test_call_llm_handles_exception(self, mock_event_bus):
        """LLM 调用失败应 fallback 到 mock"""
        def bad_llm(messages):
            raise RuntimeError("LLM unavailable")
        agent = BaseAgent(
            name="test", role="", description="",
            tools=[], event_bus=mock_event_bus, llm_call=bad_llm,
        )
        result = agent.call_llm([{"role": "user", "content": "test"}])
        # 应回退到 mock
        assert "[mock-llm]" in result


class TestBaseAgentToolCall:
    """BaseAgent.call_tool() 测试"""

    def test_call_tool_success(self, mock_event_bus):
        """成功调用工具"""
        agent = BaseAgent(
            name="test", role="", description="",
            tools=["risk"], event_bus=mock_event_bus,
        )
        # 调用真实 risk tool（mock 实现）
        result = agent.call_tool("risk", {"command": "ls"})
        assert result["tool_name"] == "risk"
        assert result["success"] is True
        assert "result" in result
        assert "duration" in result
        assert agent.get_stats()["tool_calls"] == 1

    def test_call_tool_failure(self, mock_event_bus):
        """工具调用失败应返回 error"""
        agent = BaseAgent(
            name="test", role="", description="",
            tools=[], event_bus=mock_event_bus,
        )
        result = agent.call_tool("unknown_tool", {})
        assert result["success"] is False
        assert "error" in result

    def test_call_tool_unauthorized_logs_warning(self, mock_event_bus):
        """调用未授权工具应记录警告但仍执行"""
        agent = BaseAgent(
            name="test", role="", description="",
            tools=["risk"], event_bus=mock_event_bus,
        )
        # ground 不在 tools 列表中，但应仍可调用
        result = agent.call_tool("ground", {"query": "test"})
        assert "tool_name" in result


class TestBaseAgentSystemPrompt:
    """BaseAgent.build_system_prompt() 测试"""

    def test_build_system_prompt_without_tdsf(self, mock_event_bus):
        """无 TDSF 时返回 base prompt"""
        agent = BaseAgent(
            name="test", role="测试角色", description="",
            tools=["risk"], event_bus=mock_event_bus,
        )
        prompt = agent.build_system_prompt()
        assert "test" in prompt
        assert "测试角色" in prompt

    def test_build_system_prompt_base_override(self, mock_event_bus):
        """子类重写 build_system_prompt_base"""
        class CustomAgent(BaseAgent):
            def build_system_prompt_base(self):
                return "Custom system prompt"
        agent = CustomAgent(
            name="custom", role="", description="",
            tools=[], event_bus=mock_event_bus,
        )
        prompt = agent.build_system_prompt()
        assert "Custom system prompt" in prompt


# ============================================================================
# 2. MainAgent 测试
# ============================================================================

class TestMainAgentPlan:
    """MainAgent.plan_task() 测试"""

    def test_plan_teach_task(self, mock_event_bus):
        """教学任务规划"""
        agent = MainAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("解释 nginx systemctl 命令", {})
        assert len(plan) == 1
        assert plan[0].startswith("[teach]")

    def test_plan_explore_task(self, mock_event_bus):
        """探索任务规划"""
        agent = MainAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("查找 nginx 配置文件", {})
        assert len(plan) == 1
        assert plan[0].startswith("[explore]")

    def test_plan_history_task(self, mock_event_bus):
        """历史任务规划"""
        agent = MainAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("上次 nginx 故障怎么解决的", {})
        assert len(plan) == 1
        assert plan[0].startswith("[history]")

    def test_plan_coding_task(self, mock_event_bus):
        """编码任务规划"""
        agent = MainAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("修复 nginx.conf 语法错误", {})
        assert len(plan) >= 1
        assert plan[0].startswith("[coding]")

    def test_plan_ops_task(self, mock_event_bus):
        """运维任务规划（主 Agent 自处理）"""
        agent = MainAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("nginx 启动失败", {})
        assert len(plan) >= 1
        assert plan[0].startswith("[main]")

    def test_plan_composite_coding_teach(self, mock_event_bus):
        """复合任务：编码 + 教学"""
        agent = MainAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("修复代码并讲解知识点", {})
        assert len(plan) == 2
        assert plan[0].startswith("[coding]")
        assert plan[1].startswith("[teach]")

    def test_plan_composite_explore_coding(self, mock_event_bus):
        """复合任务：探索 + 编码"""
        agent = MainAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("查找并修复代码错误", {})
        assert len(plan) == 2
        assert plan[0].startswith("[explore]")
        assert plan[1].startswith("[coding]")

    # === T-P4-01: 4 新 Agent 路由测试 ===

    def test_plan_debug_task(self, mock_event_bus):
        """调试任务规划（T-P4-01 新增）"""
        agent = MainAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("排查 nginx 启动失败根因", {})
        assert len(plan) == 1
        assert plan[0].startswith("[debug]")

    def test_plan_refactor_task(self, mock_event_bus):
        """重构任务规划（T-P4-01 新增）"""
        agent = MainAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("重构配置管理模块", {})
        assert len(plan) == 1
        assert plan[0].startswith("[refactor]")

    def test_plan_test_task(self, mock_event_bus):
        """测试任务规划（T-P4-01 新增）"""
        agent = MainAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("为 nginx 模块编写单元测试", {})
        assert len(plan) == 1
        assert plan[0].startswith("[test]")

    def test_plan_deploy_task(self, mock_event_bus):
        """部署任务规划（T-P4-01 新增）"""
        agent = MainAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("部署 nginx 到生产环境", {})
        assert len(plan) == 1
        assert plan[0].startswith("[deploy]")

    def test_plan_composite_debug_test(self, mock_event_bus):
        """复合任务：调试 + 测试（T-P4-01 新增）"""
        agent = MainAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("排查故障并验证修复测试", {})
        assert len(plan) == 2
        assert plan[0].startswith("[debug]")
        assert plan[1].startswith("[test]")


class TestMainAgentParsePrefix:
    """MainAgent._parse_task_prefix() 测试"""

    def test_parse_coding_prefix(self, mock_event_bus):
        agent = MainAgent(event_bus=mock_event_bus)
        prefix, content = agent._parse_task_prefix("[coding] 修复代码")
        assert prefix == "coding"
        assert content == "修复代码"

    def test_parse_teach_prefix(self, mock_event_bus):
        agent = MainAgent(event_bus=mock_event_bus)
        prefix, content = agent._parse_task_prefix("[teach] 讲解 nginx")
        assert prefix == "teach"
        assert content == "讲解 nginx"

    def test_parse_no_prefix(self, mock_event_bus):
        """无前缀应返回 main"""
        agent = MainAgent(event_bus=mock_event_bus)
        prefix, content = agent._parse_task_prefix("普通任务")
        assert prefix == "main"
        assert content == "普通任务"

    def test_parse_invalid_prefix(self, mock_event_bus):
        """无效前缀应返回 main"""
        agent = MainAgent(event_bus=mock_event_bus)
        prefix, content = agent._parse_task_prefix("[unknown] 任务")
        assert prefix == "main"

    # === T-P4-01: 4 新前缀解析测试 ===

    def test_parse_debug_prefix(self, mock_event_bus):
        """解析 [debug] 前缀（T-P4-01 新增）"""
        agent = MainAgent(event_bus=mock_event_bus)
        prefix, content = agent._parse_task_prefix("[debug] 排查故障")
        assert prefix == "debug"
        assert content == "排查故障"

    def test_parse_refactor_prefix(self, mock_event_bus):
        """解析 [refactor] 前缀（T-P4-01 新增）"""
        agent = MainAgent(event_bus=mock_event_bus)
        prefix, content = agent._parse_task_prefix("[refactor] 重构模块")
        assert prefix == "refactor"
        assert content == "重构模块"

    def test_parse_test_prefix(self, mock_event_bus):
        """解析 [test] 前缀（T-P4-01 新增）"""
        agent = MainAgent(event_bus=mock_event_bus)
        prefix, content = agent._parse_task_prefix("[test] 编写测试")
        assert prefix == "test"
        assert content == "编写测试"

    def test_parse_deploy_prefix(self, mock_event_bus):
        """解析 [deploy] 前缀（T-P4-01 新增）"""
        agent = MainAgent(event_bus=mock_event_bus)
        prefix, content = agent._parse_task_prefix("[deploy] 部署应用")
        assert prefix == "deploy"
        assert content == "部署应用"


class TestMainAgentInvoke:
    """MainAgent.invoke() 测试"""

    def test_invoke_single_step_main(self, configured_agents):
        """单步主 Agent 任务"""
        state = {
            "input": "nginx 启动失败",
            "session_id": "sess-1",
            "iteration": 0,
        }
        agent = get_agent("main")
        update = agent.invoke(state)
        assert "plan" in update
        assert update["plan"][0].startswith("[main]")
        assert update["next_step"] in ("continue", "done")

    def test_invoke_multi_step_composite(self, configured_agents):
        """多步复合任务"""
        state = {
            "input": "修复代码并讲解知识点",
            "session_id": "sess-1",
            "iteration": 0,
        }
        agent = get_agent("main")
        # 第一轮
        update = agent.invoke(state)
        assert update["plan"][0].startswith("[coding]")
        assert update["next_step"] == "continue"
        assert update["current_task_index"] == 1

        # 第二轮（继续下一个任务）
        state2 = {
            **state,
            "plan": update["plan"],
            "current_task_index": update["current_task_index"],
            "iteration": 1,
        }
        update2 = agent.invoke(state2)
        assert update2["next_step"] == "done"


# ============================================================================
# 3. CodingAgent 测试
# ============================================================================

class TestCodingAgent:
    """CodingAgent 测试"""

    def test_init_attributes(self, mock_event_bus):
        agent = CodingAgent(event_bus=mock_event_bus)
        assert agent.name == "coding"
        assert "risk" in agent.tools
        assert "decision" in agent.tools
        assert "confidence" in agent.tools

    def test_plan_fix_task(self, mock_event_bus):
        """修复任务规划"""
        agent = CodingAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("修复 nginx.conf 语法错误", {})
        assert len(plan) == 3  # 评估 → 决策 → 生成

    def test_plan_generate_task(self, mock_event_bus):
        """生成任务规划"""
        agent = CodingAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("生成新配置文件", {})
        assert len(plan) == 3

    def test_select_tool_risk(self, mock_event_bus):
        """选择 risk 工具"""
        agent = CodingAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("评估 sudo 命令风险", {})
        assert selection["tool_name"] == "risk"
        assert "command" in selection["params"]

    def test_select_tool_decision(self, mock_event_bus):
        """选择 decision 工具"""
        agent = CodingAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("调用方案决策", {})
        assert selection["tool_name"] == "decision"

    def test_select_tool_default_decision(self, mock_event_bus):
        """默认选择 decision 工具"""
        agent = CodingAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("普通任务", {})
        assert selection["tool_name"] == "decision"

    def test_format_observation_risk(self, mock_event_bus):
        """格式化 risk 观察结果"""
        agent = CodingAgent(event_bus=mock_event_bus)
        tool_result = {
            "tool_name": "risk",
            "success": True,
            "result": {"level": "L3", "reason": "sudo", "require_approval": True},
        }
        obs = agent.format_observation(tool_result, {})
        assert "L3" in obs
        assert "sudo" in obs

    def test_format_observation_decision(self, mock_event_bus):
        """格式化 decision 观察结果"""
        agent = CodingAgent(event_bus=mock_event_bus)
        tool_result = {
            "tool_name": "decision",
            "success": True,
            "result": {
                "decision": "proceed",
                "alternatives": ["wait"],
                "reasoning": "ok",
            },
        }
        obs = agent.format_observation(tool_result, {})
        assert "proceed" in obs

    def test_extract_command_from_state(self, mock_event_bus):
        """从 state 提取命令"""
        agent = CodingAgent(event_bus=mock_event_bus)
        state = {"tool_call_request": {"params": {"command": "sudo ls"}}}
        cmd = agent._extract_command("评估任务", state)
        assert cmd == "sudo ls"

    def test_extract_command_from_quotes(self, mock_event_bus):
        """从 task 引号提取命令"""
        agent = CodingAgent(event_bus=mock_event_bus)
        cmd = agent._extract_command('评估 "sudo rm -rf" 风险', {})
        assert cmd == "sudo rm -rf"


# ============================================================================
# 4. ExploreAgent 测试
# ============================================================================

class TestExploreAgent:
    """ExploreAgent 测试"""

    def test_init_attributes(self, mock_event_bus):
        agent = ExploreAgent(event_bus=mock_event_bus)
        assert agent.name == "explore"
        assert "ground" in agent.tools
        assert "history" in agent.tools

    def test_plan_search_task(self, mock_event_bus):
        """搜索任务规划"""
        agent = ExploreAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("查找 nginx 配置", {})
        assert len(plan) == 2  # 检索 + 评估可信度

    def test_plan_history_task(self, mock_event_bus):
        """历史探索任务"""
        agent = ExploreAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("查找历史记录", {})
        assert len(plan) == 2

    def test_select_tool_ground_default(self, mock_event_bus):
        """默认选择 ground 工具"""
        agent = ExploreAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("普通任务", {"input": "查询内容"})
        assert selection["tool_name"] == "ground"

    def test_select_tool_history(self, mock_event_bus):
        """选择 history 工具"""
        agent = ExploreAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("调用 history 工具", {})
        assert selection["tool_name"] == "history"

    def test_format_observation_ground(self, mock_event_bus):
        """格式化 ground 观察结果"""
        agent = ExploreAgent(event_bus=mock_event_bus)
        tool_result = {
            "tool_name": "ground",
            "success": True,
            "result": {
                "results": [{"content": "doc1"}, {"content": "doc2"}],
                "sources": ["db1"],
            },
        }
        obs = agent.format_observation(tool_result, {})
        assert "2" in obs  # 找到 2 条结果

    def test_format_observation_ground_empty(self, mock_event_bus):
        """ground 无结果"""
        agent = ExploreAgent(event_bus=mock_event_bus)
        tool_result = {
            "tool_name": "ground",
            "success": True,
            "result": {"results": [], "sources": []},
        }
        obs = agent.format_observation(tool_result, {})
        assert "未找到" in obs


# ============================================================================
# 5. HistoryAgent 测试
# ============================================================================

class TestHistoryAgent:
    """HistoryAgent 测试"""

    def test_init_attributes(self, mock_event_bus):
        agent = HistoryAgent(event_bus=mock_event_bus)
        assert agent.name == "history"
        assert "history" in agent.tools

    def test_plan_simple_query(self, mock_event_bus):
        """简单查询规划"""
        agent = HistoryAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("查询上次操作", {})
        assert len(plan) == 1

    def test_plan_complex_query(self, mock_event_bus):
        """复杂查询（对比/总结）规划"""
        agent = HistoryAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("对比上次和上上次操作", {})
        assert len(plan) == 2  # 检索 + 评估

    def test_select_tool_history_default(self, mock_event_bus):
        """默认选择 history 工具"""
        agent = HistoryAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("查询历史", {"input": "nginx"})
        assert selection["tool_name"] == "history"
        assert "session_id" in selection["params"]

    def test_format_observation_history(self, mock_event_bus):
        """格式化 history 观察结果"""
        agent = HistoryAgent(event_bus=mock_event_bus)
        tool_result = {
            "tool_name": "history",
            "success": True,
            "result": {"records": [{}, {}], "total": 2},
        }
        obs = agent.format_observation(tool_result, {})
        assert "2" in obs

    def test_format_observation_history_empty(self, mock_event_bus):
        """history 无结果"""
        agent = HistoryAgent(event_bus=mock_event_bus)
        tool_result = {
            "tool_name": "history",
            "success": True,
            "result": {"records": [], "total": 0},
        }
        obs = agent.format_observation(tool_result, {})
        assert "未找到" in obs

    def test_compress_context_short(self, mock_event_bus):
        """短对话不压缩"""
        agent = HistoryAgent(event_bus=mock_event_bus)
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]
        result = agent.compress_context(messages)
        assert "hello" in result
        assert "hi" in result

    def test_compress_context_long(self, mock_event_bus):
        """长对话压缩"""
        agent = HistoryAgent(event_bus=mock_event_bus)
        messages = [
            {"role": "user", "content": f"msg {i}"} for i in range(20)
        ]
        result = agent.compress_context(messages)
        assert "[Summary]" in result
        assert "msg 0" in result  # 前 5 条保留


# ============================================================================
# 6. TeachAgent 测试
# ============================================================================

class TestTeachAgent:
    """TeachAgent 测试"""

    def test_init_attributes(self, mock_event_bus):
        agent = TeachAgent(event_bus=mock_event_bus)
        assert agent.name == "teach"
        assert "ground" in agent.tools

    def test_plan_teach_task(self, mock_event_bus):
        """教学任务规划（复杂教学：3 步）"""
        agent = TeachAgent(event_bus=mock_event_bus)
        # 不含"命令"关键词，命中复杂教学（3 步）
        plan = agent.plan_task("解释 nginx 工作原理", {})
        assert len(plan) == 3  # 检索 + 评估 + 生成

    def test_plan_command_task(self, mock_event_bus):
        """命令教学规划"""
        agent = TeachAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("systemctl 命令教学", {})
        assert len(plan) == 2

    def test_select_tool_ground_default(self, mock_event_bus):
        """默认选择 ground 工具"""
        agent = TeachAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("讲解 nginx", {"input": "nginx"})
        assert selection["tool_name"] == "ground"

    def test_select_tool_credibility(self, mock_event_bus):
        """选择 credibility 工具"""
        agent = TeachAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("评估可信度 credibility", {})
        assert selection["tool_name"] == "credibility"

    def test_format_observation_ground(self, mock_event_bus):
        """格式化 ground 观察结果"""
        agent = TeachAgent(event_bus=mock_event_bus)
        tool_result = {
            "tool_name": "ground",
            "success": True,
            "result": {"results": [{}, {}], "sources": ["doc"]},
        }
        obs = agent.format_observation(tool_result, {})
        assert "2" in obs

    def test_format_observation_ground_empty(self, mock_event_bus):
        """ground 无结果"""
        agent = TeachAgent(event_bus=mock_event_bus)
        tool_result = {
            "tool_name": "ground",
            "success": True,
            "result": {"results": [], "sources": []},
        }
        obs = agent.format_observation(tool_result, {})
        assert "未找到" in obs

    def test_extract_command_name_nginx(self, mock_event_bus):
        """提取 nginx 命令名"""
        agent = TeachAgent(event_bus=mock_event_bus)
        cmd = agent._extract_command_name("解释 nginx 配置")
        assert cmd == "nginx"

    def test_extract_command_name_systemctl(self, mock_event_bus):
        """提取 systemctl 命令名"""
        agent = TeachAgent(event_bus=mock_event_bus)
        cmd = agent._extract_command_name("讲解 systemctl 命令")
        assert cmd == "systemctl"

    def test_extract_command_name_from_quotes(self, mock_event_bus):
        """从引号提取命令名"""
        agent = TeachAgent(event_bus=mock_event_bus)
        cmd = agent._extract_command_name('解释 "custom_cmd" 用法')
        assert cmd == "custom_cmd"

    def test_mock_command_purpose_nginx(self, mock_event_bus):
        """nginx 命令用途"""
        agent = TeachAgent(event_bus=mock_event_bus)
        purpose = agent._mock_command_purpose("nginx")
        assert "Web" in purpose or "Web 服务器" in purpose

    def test_mock_command_purpose_unknown(self, mock_event_bus):
        """未知命令用途"""
        agent = TeachAgent(event_bus=mock_event_bus)
        purpose = agent._mock_command_purpose("unknown_cmd")
        assert "unknown_cmd" in purpose

    def test_mock_teaching_content_structure(self, mock_event_bus):
        """mock 教学内容结构"""
        agent = TeachAgent(event_bus=mock_event_bus)
        content = agent._mock_teaching_content("解释 nginx", "(无检索结果)")
        assert "## 教程" in content
        assert "## 知识卡" in content
        assert "## 学习路径" in content
        assert "nginx" in content

    def test_generate_teaching_content_with_llm(
        self, mock_event_bus, mock_llm_call
    ):
        """LLM 生成教学内容"""
        agent = TeachAgent(event_bus=mock_event_bus, llm_call=mock_llm_call)
        state = {
            "input": "解释 nginx",
            "intermediate_results": [{
                "result": {
                    "tool_name": "ground",
                    "result": {
                        "results": [{"content": "nginx 是 Web 服务器", "source": "doc"}],
                    },
                },
            }],
        }
        content = agent._generate_teaching_content(state)
        assert "LLM response" in content

    def test_generate_teaching_content_fallback_mock(self, mock_event_bus):
        """LLM 不可用时回退到 mock"""
        agent = TeachAgent(event_bus=mock_event_bus)  # 无 llm_call
        state = {
            "input": "解释 nginx",
            "intermediate_results": [],
        }
        content = agent._generate_teaching_content(state)
        assert "## 教程" in content
        assert "nginx" in content

    def test_extract_retrieval_context(self, mock_event_bus):
        """提取检索上下文"""
        agent = TeachAgent(event_bus=mock_event_bus)
        intermediate = [{
            "result": {
                "tool_name": "ground",
                "result": {
                    "results": [{"content": "doc1", "source": "src1"}],
                },
            },
        }]
        ctx = agent._extract_retrieval_context(intermediate)
        assert "doc1" in ctx
        assert "src1" in ctx

    def test_extract_retrieval_context_empty(self, mock_event_bus):
        """空检索上下文"""
        agent = TeachAgent(event_bus=mock_event_bus)
        ctx = agent._extract_retrieval_context([])
        assert "无知识库检索结果" in ctx


# ============================================================================
# 6.5. T-P4-01 新增 4 子 Agent 测试（debug / refactor / test / deploy）
# ============================================================================

class TestDebugAgent:
    """DebugAgent 测试（T-P4-01 新增）"""

    def test_init_attributes(self, mock_event_bus):
        """初始化基础属性"""
        agent = DebugAgent(event_bus=mock_event_bus)
        assert agent.name == "debug"
        assert "risk" in agent.tools
        assert "decision" in agent.tools
        assert "history" in agent.tools
        assert "confidence" in agent.tools

    def test_plan_complex_debug_task(self, mock_event_bus):
        """复杂排查任务规划（3 步）"""
        agent = DebugAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("排查 nginx 启动失败根因", {})
        assert len(plan) == 3

    def test_plan_simple_error_task(self, mock_event_bus):
        """简单错误排查（2 步）"""
        agent = DebugAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("nginx 启动失败", {})
        assert len(plan) == 2

    def test_plan_default_single_step(self, mock_event_bus):
        """默认单步决策"""
        agent = DebugAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("普通任务", {})
        assert len(plan) == 1

    def test_select_tool_history(self, mock_event_bus):
        """选择 history 工具"""
        agent = DebugAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("调用 history 检索类似故障", {"input": "nginx"})
        assert selection["tool_name"] == "history"

    def test_select_tool_risk(self, mock_event_bus):
        """选择 risk 工具"""
        agent = DebugAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("调用 risk 评估命令风险", {})
        assert selection["tool_name"] == "risk"

    def test_select_tool_confidence(self, mock_event_bus):
        """选择 confidence 工具"""
        agent = DebugAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("调用 confidence 评估可信度", {})
        assert selection["tool_name"] == "confidence"

    def test_select_tool_default_decision(self, mock_event_bus):
        """默认选择 decision 工具"""
        agent = DebugAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("普通任务", {})
        assert selection["tool_name"] == "decision"

    def test_format_observation_history(self, mock_event_bus):
        """格式化 history 观察结果"""
        agent = DebugAgent(event_bus=mock_event_bus)
        tool_result = {
            "tool_name": "history",
            "success": True,
            "result": {"records": [{}, {}], "total": 2},
        }
        obs = agent.format_observation(tool_result, {})
        assert "2" in obs

    def test_format_observation_history_empty(self, mock_event_bus):
        """history 无结果"""
        agent = DebugAgent(event_bus=mock_event_bus)
        tool_result = {
            "tool_name": "history",
            "success": True,
            "result": {"records": [], "total": 0},
        }
        obs = agent.format_observation(tool_result, {})
        assert "未找到" in obs


class TestRefactorAgent:
    """RefactorAgent 测试（T-P4-01 新增）"""

    def test_init_attributes(self, mock_event_bus):
        """初始化基础属性"""
        agent = RefactorAgent(event_bus=mock_event_bus)
        assert agent.name == "refactor"
        assert "risk" in agent.tools
        assert "decision" in agent.tools
        assert "confidence" in agent.tools

    def test_plan_complex_refactor_task(self, mock_event_bus):
        """复杂重构任务规划（3 步）"""
        agent = RefactorAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("重构配置管理模块", {})
        assert len(plan) == 3

    def test_plan_simple_modify_task(self, mock_event_bus):
        """简单修改任务（2 步）"""
        agent = RefactorAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("调整代码结构", {})
        assert len(plan) == 2

    def test_plan_default_single_step(self, mock_event_bus):
        """默认单步决策"""
        agent = RefactorAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("普通任务", {})
        assert len(plan) == 1

    def test_select_tool_risk(self, mock_event_bus):
        """选择 risk 工具"""
        agent = RefactorAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("调用 risk 评估操作风险", {})
        assert selection["tool_name"] == "risk"

    def test_select_tool_confidence(self, mock_event_bus):
        """选择 confidence 工具"""
        agent = RefactorAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("调用 confidence 评估可信度", {})
        assert selection["tool_name"] == "confidence"

    def test_select_tool_default_decision(self, mock_event_bus):
        """默认选择 decision 工具"""
        agent = RefactorAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("普通任务", {})
        assert selection["tool_name"] == "decision"

    def test_format_observation_risk(self, mock_event_bus):
        """格式化 risk 观察结果"""
        agent = RefactorAgent(event_bus=mock_event_bus)
        tool_result = {
            "tool_name": "risk",
            "success": True,
            "result": {"level": "L2", "reason": "code change"},
        }
        obs = agent.format_observation(tool_result, {})
        assert "L2" in obs


class TestTestAgent:
    """TestAgent 测试（T-P4-01 新增）"""

    def test_init_attributes(self, mock_event_bus):
        """初始化基础属性"""
        agent = TestAgent(event_bus=mock_event_bus)
        assert agent.name == "test"
        assert "risk" in agent.tools
        assert "decision" in agent.tools
        assert "confidence" in agent.tools

    def test_plan_complex_test_task(self, mock_event_bus):
        """复杂测试任务规划（3 步）"""
        agent = TestAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("为 nginx 模块编写单元测试", {})
        assert len(plan) == 3

    def test_plan_simple_verify_task(self, mock_event_bus):
        """简单验证任务（2 步）"""
        agent = TestAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("验证修复结果", {})
        assert len(plan) == 2

    def test_plan_default_single_step(self, mock_event_bus):
        """默认单步决策"""
        agent = TestAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("普通任务", {})
        assert len(plan) == 1

    def test_select_tool_risk(self, mock_event_bus):
        """选择 risk 工具"""
        agent = TestAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("调用 risk 评估命令风险", {})
        assert selection["tool_name"] == "risk"

    def test_select_tool_default_decision(self, mock_event_bus):
        """默认选择 decision 工具"""
        agent = TestAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("普通任务", {})
        assert selection["tool_name"] == "decision"


class TestDeployAgent:
    """DeployAgent 测试（T-P4-01 新增）"""

    def test_init_attributes(self, mock_event_bus):
        """初始化基础属性"""
        agent = DeployAgent(event_bus=mock_event_bus)
        assert agent.name == "deploy"
        assert "risk" in agent.tools
        assert "decision" in agent.tools
        assert "confidence" in agent.tools

    def test_plan_complex_deploy_task(self, mock_event_bus):
        """复杂部署任务规划（3 步）"""
        agent = DeployAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("部署 nginx 到生产环境", {})
        assert len(plan) == 3

    def test_plan_simple_restart_task(self, mock_event_bus):
        """简单重启任务（2 步）"""
        agent = DeployAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("重启 nginx 服务", {})
        assert len(plan) == 2

    def test_plan_default_single_step(self, mock_event_bus):
        """默认单步决策"""
        agent = DeployAgent(event_bus=mock_event_bus)
        plan = agent.plan_task("普通任务", {})
        assert len(plan) == 1

    def test_select_tool_risk(self, mock_event_bus):
        """选择 risk 工具"""
        agent = DeployAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("调用 risk 评估命令风险", {})
        assert selection["tool_name"] == "risk"

    def test_select_tool_default_decision(self, mock_event_bus):
        """默认选择 decision 工具"""
        agent = DeployAgent(event_bus=mock_event_bus)
        selection = agent.select_tool("普通任务", {})
        assert selection["tool_name"] == "decision"


# ============================================================================
# 7. AGENT_REGISTRY + 全局配置测试（P4 扩展至 9 Agent）
# ============================================================================

class TestAgentRegistry:
    """Agent 注册表测试（P4 扩展至 9 Agent）"""

    def test_registry_contains_9_agents(self):
        """注册表包含 9 个 Agent（P4 扩展）"""
        assert len(AGENT_REGISTRY) == 9
        expected = (
            "main", "coding", "explore", "history", "teach",
            "debug", "refactor", "test", "deploy",
        )
        for name in expected:
            assert name in AGENT_REGISTRY

    def test_list_agents(self):
        """list_agents 返回所有 9 个 Agent 名"""
        agents_list = list_agents()
        expected = {
            "main", "coding", "explore", "history", "teach",
            "debug", "refactor", "test", "deploy",
        }
        assert set(agents_list) == expected

    def test_get_agent_unconfigured_raises(self):
        """未配置时 get_agent 抛 RuntimeError"""
        with pytest.raises(RuntimeError):
            get_agent("main")

    def test_get_agent_unknown_raises(self, configured_agents):
        """未知 Agent 名抛 KeyError"""
        with pytest.raises(KeyError):
            get_agent("unknown")

    def test_configure_agents_instantiates_all(self, mock_event_bus):
        """configure_agents 实例化所有 9 个 Agent"""
        configure_agents(event_bus=mock_event_bus)
        expected = (
            "main", "coding", "explore", "history", "teach",
            "debug", "refactor", "test", "deploy",
        )
        for name in expected:
            agent = get_agent(name)
            assert agent.name == name

    def test_invoke_agent(self, configured_agents):
        """invoke_agent 统一调用入口"""
        state = {"input": "测试", "session_id": "sess-1", "iteration": 0}
        update = invoke_agent("main", state)
        assert isinstance(update, dict)
        assert "next_step" in update

    def test_invoke_agent_uses_backend_override(self, configured_agents):
        """invoke_agent 优先走 _global_backend_override 路径（TDSF P0-E 修复回归测试）

        场景：set_backend() 注入 Strands 适配层后，invoke_agent 必须调 override
        而非 BaseAgent.invoke。验证：
        1. override 被调用时收到正确的 (agent_id, input, state) 三参
        2. invoke_agent 返回 override 的返回值，不走 BaseAgent.invoke
        3. clear_backend() 后回退到 BaseAgent PAOR 主路径
        """
        # 准备：构造一个可追踪调用参数的 override
        call_log: list[dict] = []

        def fake_override(agent_id: str, input: str, state: dict) -> dict:
            call_log.append({
                "agent_id": agent_id,
                "input": input,
                "state_keys": sorted(state.keys()),
            })
            return {
                "observation": f"strands-handled: {input}",
                "next_step": "done",
                "mood": "done",
                "intermediate_results": [],
            }

        # 注入 override
        set_backend(fake_override)
        try:
            state = {
                "input": "检查 nginx 状态",
                "session_id": "sess-strands-1",
                "iteration": 0,
            }
            update = invoke_agent("main", state)

            # 断言 1：override 被调用，参数正确
            assert len(call_log) == 1
            assert call_log[0]["agent_id"] == "main"
            assert call_log[0]["input"] == "检查 nginx 状态"
            assert "input" in call_log[0]["state_keys"]
            assert "session_id" in call_log[0]["state_keys"]

            # 断言 2：返回值来自 override，而非 BaseAgent
            assert update["observation"] == "strands-handled: 检查 nginx 状态"
            assert update["next_step"] == "done"
            assert update["mood"] == "done"
        finally:
            clear_backend()

        # 断言 3：clear_backend 后回退到 BaseAgent PAOR
        state2 = {"input": "回退测试", "session_id": "sess-2", "iteration": 0}
        update2 = invoke_agent("main", state2)
        assert isinstance(update2, dict)
        assert "next_step" in update2
        # 不应包含 override 的标记
        assert update2.get("observation") != "strands-handled: 回退测试"

    def test_set_backend_rejects_non_callable(self):
        """set_backend 拒绝非可调用对象"""
        with pytest.raises(TypeError, match="callable"):
            set_backend("not a callable")  # type: ignore[arg-type]

    def test_clear_backend_idempotent(self):
        """clear_backend 在未设置时也安全（幂等）"""
        # 确保未设置
        clear_backend()
        # 再次清除不应抛错
        clear_backend()

    def test_reset_for_test_clears_instances(self, configured_agents):
        """reset_for_test 清除实例"""
        # 配置后能获取
        get_agent("main")
        # 重置后无法获取
        reset_for_test()
        with pytest.raises(RuntimeError):
            get_agent("main")


# ============================================================================
# 8. JSON-RPC 方法注册测试
# ============================================================================

class TestJsonRpcMethods:
    """JSON-RPC 方法注册测试"""

    def test_register_methods(self):
        """register_methods 注册 4 个方法"""
        dispatcher = MagicMock()
        register_methods(dispatcher)
        assert dispatcher.register.call_count == 4
        registered_names = [call.args[0] for call in dispatcher.register.call_args_list]
        assert "agent.invoke" in registered_names
        assert "agent.list" in registered_names
        assert "agent.info" in registered_names
        assert "agent.configure" in registered_names

    def test_rpc_agent_list(self, configured_agents):
        """agent.list 返回 9 个 Agent 列表（P4 扩展）"""
        from agents import _rpc_agent_list
        result = _rpc_agent_list()
        assert "agents" in result
        assert len(result["agents"]) == 9
        assert "configured" in result

    def test_rpc_agent_info(self, configured_agents):
        """agent.info 返回 Agent 元数据"""
        from agents import _rpc_agent_info
        info = _rpc_agent_info("coding")
        assert info["name"] == "coding"
        assert "role" in info
        assert "tools" in info
        assert "system_prompt" in info

    def test_rpc_agent_invoke(self, configured_agents):
        """agent.invoke 调用 Agent"""
        from agents import _rpc_agent_invoke
        state = {"input": "测试", "session_id": "", "iteration": 0}
        update = _rpc_agent_invoke("main", state)
        assert "next_step" in update


# ============================================================================
# 9. AgentResult 数据结构测试
# ============================================================================

class TestAgentResult:
    """AgentResult 测试"""

    def test_to_state_update_basic(self):
        """基本状态更新"""
        result = AgentResult(
            observation="测试观察",
            next_step="done",
            mood="done",
        )
        update = result.to_state_update()
        assert update["observation"] == "测试观察"
        assert update["next_step"] == "done"
        assert update["mood"] == "done"

    def test_to_state_update_with_intermediate(self):
        """含中间结果"""
        result = AgentResult(
            observation="...",
            intermediate_results=[{"task": "t1", "result": {}}],
        )
        update = result.to_state_update()
        assert "intermediate_results" in update
        assert len(update["intermediate_results"]) == 1

    def test_to_state_update_with_error(self):
        """含错误"""
        result = AgentResult(error="test error")
        update = result.to_state_update()
        assert update["error"] == "test error"

    def test_to_state_update_with_extra(self):
        """含附加更新"""
        result = AgentResult(
            extra_update={"custom_field": "value"},
        )
        update = result.to_state_update()
        assert update["custom_field"] == "value"

    def test_defaults(self):
        """默认值"""
        result = AgentResult()
        assert result.observation == ""
        assert result.next_step == "continue"
        assert result.mood == "working"
        assert result.intermediate_results == []
