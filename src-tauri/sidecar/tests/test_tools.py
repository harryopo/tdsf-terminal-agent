"""
tests/test_tools.py — MCP tools 单元测试（T-P1-07.8 验证）
============================================================

验证内容：
1. risk tool（T-P1-07.1）
   - 必填参数校验
   - L0-L4 输出格式
   - 4 层风控管道触发
2. confidence tool（T-P1-07.2）
   - 三种方法：baseline / D-S / D-S+PCR5
   - 输入解析（dict → Evidence）
   - 自洽采样一致率
3. ground tool（T-P1-07.3）
   - FTS5 入库 + 检索
   - hybrid 融合（ChromaDB 不可用时降级为 keyword）
   - 参数校验
4. decision tool（T-P1-07.4）
   - 调用 DecisionEngine
   - 参数校验
5. credibility tool（T-P1-07.5）
   - 三维度评估
   - 权重归一化
   - 时效衰减
6. history tool（T-P1-07.6）
   - CRUD 全流程
   - FTS5 关键词检索
   - make_history_callback 适配器
7. tools/__init__.py 注册表
   - TOOL_REGISTRY 完整性
   - invoke_tool 路由
   - list_tools / get_tool_metadata

运行：
    cd python-sidecar
    python -m pytest tests/test_tools.py -v
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

# 确保能 import core / tools 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

# === tools 模块导入 ===
from tools import (
    TOOL_REGISTRY,
    get_tool_metadata,
    invoke_confidence_tool,
    invoke_credibility_tool,
    invoke_decision_tool,
    invoke_ground_tool,
    invoke_history_tool,
    invoke_risk_tool,
    invoke_tool,
    list_tools,
)
from tools.confidence import reset_calculators as reset_confidence_calculators
from tools.decision import reset_decision_engine
from tools.ground import (
    add_documents as ground_add_documents,
    reset_chroma,
    reset_kb_db,
)
from tools.history import reset_db as reset_history_db
from tools.risk import reset_risk_engine


# ============================================================================
# 共享 Fixture
# ============================================================================


@pytest.fixture(autouse=True)
def reset_singletons():
    """每个测试前后重置所有 tools 单例，保证隔离"""
    # 测试前重置（防止上一次测试残留状态污染）
    reset_risk_engine()
    reset_confidence_calculators()
    reset_decision_engine()
    reset_kb_db()
    reset_chroma()
    reset_history_db()
    yield
    # 测试后重置（清理本次测试产生的状态）
    reset_risk_engine()
    reset_confidence_calculators()
    reset_decision_engine()
    reset_kb_db()
    reset_chroma()
    reset_history_db()


@pytest.fixture
def temp_db_paths(tmp_path):
    """临时数据库路径（每个测试独立）"""
    return {
        "kb_db": tmp_path / "kb.db",
        "history_db": tmp_path / "history.db",
        "chroma": tmp_path / "chroma",
    }


# ============================================================================
# 1. risk tool 测试（T-P1-07.1）
# ============================================================================


class TestRiskTool:
    """risk tool 接口测试"""

    def test_missing_command_raises(self):
        """缺少 command 参数应抛 ValueError"""
        with pytest.raises(ValueError, match="command is required"):
            invoke_risk_tool({})

    def test_invalid_command_type_raises(self):
        """command 非 str 应抛 ValueError"""
        with pytest.raises(ValueError, match="command must be str"):
            invoke_risk_tool({"command": 123})

    def test_returns_l0_l4_format(self):
        """返回值含 L0-L4 字段"""
        result = invoke_risk_tool({"command": "ls -la"})
        assert "level" in result
        assert result["level"] in ["L0", "L1", "L2", "L3", "L4"]
        assert "risk_level" in result
        assert "require_approval" in result
        assert isinstance(result["require_approval"], bool)

    def test_dangerous_command_high_or_deny(self):
        """危险命令应返回 L3 或 L4"""
        result = invoke_risk_tool({"command": "sudo rm -rf /"})
        assert result["level"] in ["L3", "L4"]
        assert result["risk_level"] in ["high", "deny"]

    def test_safe_command_low(self):
        """安全命令应返回 L0"""
        result = invoke_risk_tool({"command": "ls -la"})
        assert result["level"] == "L0"
        assert result["risk_level"] == "low"


# ============================================================================
# 2. confidence tool 测试（T-P1-07.2）
# ============================================================================


class TestConfidenceTool:
    """confidence tool 接口测试"""

    def test_missing_evidences_raises(self):
        """缺少 evidences 应抛 ValueError"""
        with pytest.raises(ValueError, match="evidences is required"):
            invoke_confidence_tool({})

    def test_invalid_evidences_type_raises(self):
        """evidences 非 list 应抛 ValueError"""
        with pytest.raises(ValueError, match="evidences must be list"):
            invoke_confidence_tool({"evidences": "not a list"})

    def test_baseline_method(self):
        """baseline 方法应返回 score + method"""
        result = invoke_confidence_tool({
            "evidences": [
                {
                    "raw_text": "MySQL error log: lock conflict",
                    "source": "mysql/error.log",
                    "drain3_match_score": 0.9,
                    "is_grounded": True,
                }
            ],
            "method": "baseline",
        })
        assert "score" in result
        assert 0.0 <= result["score"] <= 1.0
        assert result["method"] == "baseline"
        assert result["conflict"] == 0.0  # baseline 不计算冲突
        assert result["evidence_count"] == 1
        assert result["grounded_count"] == 1

    def test_dspcr5_default_method(self):
        """默认方法为 D-S+PCR5"""
        result = invoke_confidence_tool({
            "evidences": [
                {
                    "raw_text": "evidence 1",
                    "source": "journalctl",
                    "drain3_match_score": 0.85,
                    "is_grounded": True,
                },
                {
                    "raw_text": "evidence 2",
                    "source": "syslog",
                    "drain3_match_score": 0.80,
                    "is_grounded": True,
                },
            ],
        })
        assert result["method"] == "D-S+PCR5"
        assert 0.0 <= result["score"] <= 1.0
        assert 0.0 <= result["conflict"] <= 1.0

    def test_with_samples(self):
        """提供 samples 时应计算 self_consistency"""
        result = invoke_confidence_tool({
            "evidences": [
                {
                    "raw_text": "evidence",
                    "source": "syslog",
                    "drain3_match_score": 0.8,
                    "is_grounded": True,
                }
            ],
            "samples": ["结论A", "结论A", "结论A", "结论B"],
        })
        assert "self_consistency" in result
        assert result["self_consistency"] == 0.75  # 3/4

    def test_unsupported_method_falls_back(self):
        """非法方法应回退到 D-S+PCR5"""
        result = invoke_confidence_tool({
            "evidences": [
                {
                    "raw_text": "evidence",
                    "source": "syslog",
                    "drain3_match_score": 0.8,
                    "is_grounded": True,
                }
            ],
            "method": "invalid_method",
        })
        assert result["method"] == "D-S+PCR5"


# ============================================================================
# 3. ground tool 测试（T-P1-07.3）
# ============================================================================


class TestGroundTool:
    """ground tool 接口测试"""

    def test_missing_query_raises(self):
        """缺少 query 应抛 ValueError"""
        with pytest.raises(ValueError, match="query is required"):
            invoke_ground_tool({})

    def test_invalid_query_type_raises(self):
        """query 非 str 应抛 ValueError"""
        with pytest.raises(ValueError, match="query must be str"):
            invoke_ground_tool({"query": 123})

    def test_empty_kb_returns_empty_results(self):
        """空知识库检索应返回空 results"""
        result = invoke_ground_tool({"query": "nginx", "method": "keyword"})
        assert result["total"] == 0
        assert result["results"] == []
        assert isinstance(result["sources"], list)
        assert len(result["sources"]) == 2  # vector + keyword

    def test_add_documents_and_search(self):
        """添加文档后应能检索到"""
        # 入库
        add_result = ground_add_documents([
            {
                "doc_id": "test-doc-001",
                "content": "nginx 启动失败排查步骤：1. 检查配置文件 nginx -t",
                "title": "nginx 故障排查",
                "source_file": "knowledge/nginx.md",
                "metadata": {"type": "tutorial"},
            }
        ])
        assert add_result["added_count"] == 1

        # 检索
        result = invoke_ground_tool({
            "query": "nginx 启动失败",
            "method": "keyword",
            "top_k": 5,
        })
        assert result["total"] >= 1
        assert any(r["id"] == "test-doc-001" for r in result["results"])
        assert result["method"] == "keyword"

    def test_invalid_filter_metadata_type_raises(self):
        """filter_metadata 非 dict 应抛 ValueError"""
        with pytest.raises(ValueError, match="filter_metadata must be dict"):
            invoke_ground_tool({"query": "test", "filter_metadata": "not a dict"})


# ============================================================================
# 4. decision tool 测试（T-P1-07.4）
# ============================================================================


class TestDecisionTool:
    """decision tool 接口测试"""

    def test_missing_problem_description_raises(self):
        """缺少 problem_description 应抛 ValueError"""
        with pytest.raises(ValueError, match="problem_description is required"):
            invoke_decision_tool({})

    def test_invalid_problem_description_type_raises(self):
        """problem_description 非 str 应抛 ValueError"""
        with pytest.raises(ValueError, match="problem_description must be str"):
            invoke_decision_tool({"problem_description": 123})

    def test_invalid_fix_commands_type_raises(self):
        """fix_commands 非 list 应抛 ValueError"""
        with pytest.raises(ValueError, match="fix_commands must be list"):
            invoke_decision_tool({
                "problem_description": "test",
                "fix_commands": "not a list",
            })

    def test_low_risk_proceed(self):
        """低风险命令应返回 decision=proceed"""
        result = invoke_decision_tool({
            "problem_description": "查看系统状态",
            "fix_commands": ["ls -la"],
        })
        assert result["decision"] in ["proceed", "needs_approval", "abort", "use_history"]
        assert "alternatives" in result
        assert "reasoning" in result
        assert "confidence" in result
        assert "hitl_status" in result


# ============================================================================
# 5. credibility tool 测试（T-P1-07.5）
# ============================================================================


class TestCredibilityTool:
    """credibility tool 接口测试"""

    def test_known_source_high_score(self):
        """已知来源（dmesg）应有较高 source 分数"""
        result = invoke_credibility_tool({
            "source": "dmesg",
            "age_seconds": 60,  # 1 分钟前
            "consensus_count": 5,
            "dissenting_count": 0,
        })
        assert "credibility" in result
        assert 0.0 <= result["credibility"] <= 1.0
        assert result["factors"]["source"] >= 0.9  # dmesg prior=0.95
        assert result["factors"]["temporal"] >= 0.9  # 1 分钟很新
        assert result["factors"]["consistency"] == 1.0  # 5 vs 0
        assert result["details"]["source_known"] is True

    def test_unknown_source(self):
        """未知来源应标记 source_known=False"""
        result = invoke_credibility_tool({
            "source": "completely_unknown_source",
        })
        assert result["details"]["source_known"] is False
        assert result["factors"]["source"] == 0.5  # 未知来源先验

    def test_temporal_decay(self):
        """时效衰减：7 天前数据 temporal 应接近 0"""
        result = invoke_credibility_tool({
            "source": "dmesg",
            "age_seconds": 7 * 24 * 3600,  # 7 天
        })
        assert result["factors"]["temporal"] < 0.1

    def test_weights_normalization(self):
        """权重应自动归一化"""
        result = invoke_credibility_tool({
            "source": "dmesg",
            "weights": {"source": 2.0, "temporal": 1.0, "consistency": 1.0},
        })
        total = sum(result["weights"].values())
        assert abs(total - 1.0) < 0.01

    def test_invalid_source_type_raises(self):
        """source 非 str 应抛 ValueError"""
        with pytest.raises(ValueError, match="source must be str"):
            invoke_credibility_tool({"source": 123})

    def test_no_data_returns_medium(self):
        """无任何数据应返回中等分数（不惩罚也不奖励）"""
        result = invoke_credibility_tool({})
        assert 0.4 <= result["credibility"] <= 0.6
        assert result["factors"]["source"] == 0.5
        assert result["factors"]["temporal"] == 0.5
        assert result["factors"]["consistency"] == 0.5


# ============================================================================
# 6. history tool 测试（T-P1-07.6）
# ============================================================================


class TestHistoryTool:
    """history tool 接口测试"""

    def test_add_and_get_case(self):
        """添加案例后能按 case_id 获取"""
        add_result = invoke_history_tool({
            "action": "add",
            "case": {
                "problem_description": "MySQL 启动失败",
                "fix_commands": ["systemctl restart mysql"],
                "success_rating": 1.0,
                "outcome": "success",
            },
        })
        assert add_result["action"] == "add"
        case_id = add_result["case"]["case_id"]
        assert case_id  # 非空

        # 获取
        get_result = invoke_history_tool({
            "action": "get",
            "case_id": case_id,
        })
        assert get_result["case"] is not None
        assert get_result["case"]["problem_description"] == "MySQL 启动失败"
        assert get_result["case"]["fix_commands"] == ["systemctl restart mysql"]

    def test_add_missing_problem_raises(self):
        """add 缺少 problem_description 应抛 ValueError"""
        with pytest.raises(ValueError, match="problem_description is required"):
            invoke_history_tool({
                "action": "add",
                "case": {"fix_commands": ["ls"]},
            })

    def test_search_by_keyword(self):
        """关键词检索应返回匹配案例"""
        # 添加多个案例
        invoke_history_tool({
            "action": "add",
            "case": {
                "problem_description": "nginx 启动失败排查",
                "fix_commands": ["nginx -t"],
                "success_rating": 0.9,
            },
        })
        invoke_history_tool({
            "action": "add",
            "case": {
                "problem_description": "MySQL 主从同步异常",
                "fix_commands": ["systemctl restart mysql"],
                "success_rating": 0.85,
            },
        })

        # 检索 "nginx"
        result = invoke_history_tool({
            "action": "search",
            "query": "nginx",
        })
        assert result["action"] == "search"
        assert result["total"] >= 1
        # 至少有一个含 "nginx" 的案例
        nginx_cases = [
            c for c in result["cases"]
            if "nginx" in c["problem_description"].lower()
        ]
        assert len(nginx_cases) >= 1

    def test_search_by_min_success_rating(self):
        """min_success_rating 过滤"""
        invoke_history_tool({
            "action": "add",
            "case": {
                "problem_description": "test low rating",
                "fix_commands": [],
                "success_rating": 0.3,
            },
        })
        invoke_history_tool({
            "action": "add",
            "case": {
                "problem_description": "test high rating",
                "fix_commands": [],
                "success_rating": 0.95,
            },
        })

        # 仅查 success_rating >= 0.8
        result = invoke_history_tool({
            "action": "search",
            "min_success_rating": 0.8,
        })
        assert all(c["success_rating"] >= 0.8 for c in result["cases"])
        assert result["total"] >= 1

    def test_update_case(self):
        """更新案例字段"""
        add_result = invoke_history_tool({
            "action": "add",
            "case": {
                "problem_description": "test update",
                "fix_commands": [],
                "success_rating": 0.5,
            },
        })
        case_id = add_result["case"]["case_id"]

        update_result = invoke_history_tool({
            "action": "update",
            "case_id": case_id,
            "updates": {"success_rating": 0.95, "outcome": "success"},
        })
        assert update_result["case"]["success_rating"] == 0.95
        assert update_result["case"]["outcome"] == "success"

    def test_delete_case(self):
        """删除案例"""
        add_result = invoke_history_tool({
            "action": "add",
            "case": {"problem_description": "test delete", "fix_commands": []},
        })
        case_id = add_result["case"]["case_id"]

        del_result = invoke_history_tool({
            "action": "delete",
            "case_id": case_id,
        })
        assert del_result["deleted"] is True

        # 再次获取应为 None
        get_result = invoke_history_tool({
            "action": "get",
            "case_id": case_id,
        })
        assert get_result["case"] is None

    def test_delete_nonexistent_returns_false(self):
        """删除不存在的案例应返回 deleted=False"""
        result = invoke_history_tool({
            "action": "delete",
            "case_id": "nonexistent-case-id",
        })
        assert result["deleted"] is False

    def test_list_with_session_filter(self):
        """list 按 session_id 过滤"""
        invoke_history_tool({
            "action": "add",
            "case": {
                "session_id": "sess-A",
                "problem_description": "case A",
                "fix_commands": [],
            },
        })
        invoke_history_tool({
            "action": "add",
            "case": {
                "session_id": "sess-B",
                "problem_description": "case B",
                "fix_commands": [],
            },
        })

        result = invoke_history_tool({
            "action": "list",
            "session_id": "sess-A",
        })
        assert all(c["session_id"] == "sess-A" for c in result["cases"])
        assert result["total"] >= 1

    def test_make_history_callback(self):
        """make_history_callback 应返回符合 DecisionEngine 期望格式的列表"""
        from tools.history import make_history_callback

        # 添加案例
        invoke_history_tool({
            "action": "add",
            "case": {
                "problem_description": "nginx 启动失败",
                "fix_commands": ["nginx -t", "systemctl restart nginx"],
                "success_rating": 0.95,
                "outcome": "success",
            },
        })

        callback = make_history_callback(min_success_rating=0.8)
        cases = callback("nginx 启动失败")

        assert isinstance(cases, list)
        assert len(cases) >= 1
        case = cases[0]
        # DecisionEngine 期望的字段
        assert "problem_description" in case
        assert "fix_commands" in case
        assert "success_rating" in case
        assert case["source"] == "history"

    def test_invalid_action_raises(self):
        """非法 action 应抛 ValueError"""
        with pytest.raises(ValueError, match="action must be one of"):
            invoke_history_tool({"action": "invalid"})


# ============================================================================
# 7. tools/__init__.py 注册表测试
# ============================================================================


class TestToolRegistry:
    """tools/__init__.py 注册表测试"""

    def test_registry_has_nine_tools(self):
        """TOOL_REGISTRY 应包含 9 个工具（P4 新增 worktree_fanout/rlm_fanout/steer_inject）"""
        assert len(TOOL_REGISTRY) == 9
        expected_names = {
            "risk", "confidence", "ground", "decision", "credibility", "history",
            "worktree_fanout", "rlm_fanout", "steer_inject",
        }
        assert set(TOOL_REGISTRY.keys()) == expected_names

    def test_list_tools_returns_nine(self):
        """list_tools() 应返回 9 个工具名"""
        tools = list_tools()
        assert len(tools) == 9

    def test_invoke_tool_routes_correctly(self):
        """invoke_tool 应正确路由到对应工具"""
        # 用 risk 工具测试路由（其他工具会触发更复杂逻辑）
        result = invoke_tool("risk", {"command": "ls -la"})
        assert "level" in result
        assert "risk_level" in result

    def test_invoke_tool_unknown_raises(self):
        """invoke_tool 未知工具应抛 KeyError"""
        with pytest.raises(KeyError, match="unknown tool"):
            invoke_tool("nonexistent", {})

    def test_get_tool_metadata_for_each(self):
        """每个工具都应有元数据"""
        for name in [
            "risk", "confidence", "ground", "decision", "credibility", "history",
            "worktree_fanout", "rlm_fanout", "steer_inject",
        ]:
            metadata = get_tool_metadata(name)
            assert "name" in metadata
            assert metadata["name"] == name
            assert "description" in metadata
            assert "input_schema" in metadata
            assert "output_schema" in metadata

    def test_get_tool_metadata_unknown_raises(self):
        """get_tool_metadata 未知工具应抛 KeyError"""
        with pytest.raises(KeyError, match="unknown tool"):
            get_tool_metadata("nonexistent")


# ============================================================================
# 8. 工具元数据完整性测试
# ============================================================================


class TestToolMetadata:
    """所有工具元数据的完整性测试"""

    @pytest.mark.parametrize("tool_name", [
        "risk", "confidence", "ground", "decision", "credibility", "history"
    ])
    def test_metadata_has_required_fields(self, tool_name):
        """每个工具元数据应包含必填字段"""
        metadata = get_tool_metadata(tool_name)
        assert metadata["name"] == tool_name
        assert isinstance(metadata["description"], str)
        assert len(metadata["description"]) > 0
        assert "type" in metadata["input_schema"]
        assert metadata["input_schema"]["type"] == "object"
        assert "properties" in metadata["input_schema"]
        assert "type" in metadata["output_schema"]
        assert metadata["output_schema"]["type"] == "object"
        assert "properties" in metadata["output_schema"]
