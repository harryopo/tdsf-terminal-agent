# Python Agent ↔ MCP Tools 接口切面文档（DEC-V32-05）

> **版本**：v1.0.0
> **最后更新**：2026-07-26
> **对应 spec**：T-P2-12.1 / DEC-V32-05 / T-P1-07
> **代码基线**：`python-sidecar/tools/__init__.py` + `python-sidecar/tools/{risk,confidence,ground,decision,credibility,history}.py`
> **协议**：Python 函数调用（`invoke_tool(name, params) -> dict`）

---

## 0. 文档目的

本文档作为 **Python Agent（agents/ + graph/nodes.py）↔ MCP Tools（tools/）** 之间的接口切面契约，覆盖以下内容：

- 6 个核心 MCP tools 的输入参数 schema
- 输出格式 schema（与 spec 4-api-contract.md 对齐）
- 统一调度入口 `invoke_tool(name, params)`
- 工具元数据 `TOOL_METADATA`（供 LLM function calling）
- 各 tool 的内部依赖（RiskEngine / ConfidenceEngine / ChromaDB / DecisionEngine / SQLite）
- 错误处理与失败回退策略
- Agent 调用 tool 的完整时序

**与 rust-python.md 的分层**：
- `rust-python.md`：Rust ↔ Python JSON-RPC（进程间通信）
- **本文档**：Python 内部 Agent ↔ Tools 函数调用（无 IPC）

---

## 1. 接口总览

### 1.1 6 个核心 MCP Tools 架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Python Agent 层                                  │
│                                                                         │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐  │
│   │  MainAgent   │  │ CodingAgent  │  │   graph/nodes.py             │  │
│   │              │  │              │  │   act_node / tool_call_node  │  │
│   └──────┬───────┘  └──────┬───────┘  └──────────┬───────────────────┘  │
│          │                 │                     │                      │
│          └─────────────────┴─────────────────────┘                      │
│                              │                                          │
│                              │  self.call_tool(name, params)            │
│                              │  tools.invoke_tool(name, params)         │
│                              ▼                                          │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      tools/__init__.py                                  │
│                                                                         │
│   TOOL_REGISTRY = {                                                     │
│       "risk":        invoke_risk_tool,                                  │
│       "confidence":  invoke_confidence_tool,                            │
│       "ground":      invoke_ground_tool,                                │
│       "decision":    invoke_decision_tool,                              │
│       "credibility": invoke_credibility_tool,                           │
│       "history":     invoke_history_tool,                               │
│   }                                                                     │
│                                                                         │
│   invoke_tool(name, params) -> dict                                     │
└─────────────────────────────────────────────────────────────────────────┘
                              │
        ┌──────────┬─────────┼─────────┬──────────┬──────────┐
        ▼          ▼         ▼         ▼          ▼          ▼
   ┌────────┐ ┌─────────┐ ┌──────┐ ┌──────────┐ ┌──────────┐ ┌────────┐
   │ risk   │ │confiden.│ │ground│ │ decision │ │credibili.│ │history │
   │        │ │         │ │      │ │          │ │          │ │        │
   │ Risk   │ │ D-S +   │ │ Chro │ │ Decision │ │ Source + │ │ SQLite │
   │ Engine │ │ PCR5    │ │ maDB │ │ Engine   │ │ Timeliness│ │ + 5表  │
   │        │ │         │ │ +FTS │ │          │ │ + Consist.│ │        │
   └────────┘ └─────────┘ └──────┘ └──────────┘ └──────────┘ └────────┘
   4 档风控    证据融合    双路检索   决策推理    三维度评估   CRUD + 检索
```

### 1.2 6 个 Tools 职责矩阵

| 工具名 | 输入参数 | 输出关键字段 | 内部依赖 | 调用场景 |
|--------|----------|-------------|----------|----------|
| `risk` | `command` (必填) / `target_asset` | `level` (L0-L4) / `require_approval` | `RiskEngine` + `risk_rules.yaml` | 任何命令执行前 |
| `confidence` | `evidence: list` | `score` (0-1) / `method` | `ConfidenceEngine` (D-S+PCR5) | 多源证据融合 |
| `ground` | `query` / `top_k` | `results: list` / `sources` | ChromaDB + FTS5 | 知识库检索 |
| `decision` | `command` / `risk_level` / `confidence` | `decision` / `alternatives` / `reasoning` | `DecisionEngine` | 综合决策 |
| `credibility` | `source` / `content` / `timestamp` | `credibility` (0-1) / `factors` | 三维度评估 | 来源可信度评估 |
| `history` | `action` (CRUD) / `query` | `records: list` / `total` | SQLite `history.db` | 历史案例查询 |

### 1.3 命名规则

| 项 | 命名风格 | 示例 |
|----|----------|------|
| 工具名 | lowercase | `risk` / `ground` / `decision` |
| 入口函数 | `invoke_<name>_tool` | `invoke_risk_tool` |
| 元数据函数 | `get_tool_metadata` | 返回 `{name, description, input_schema, output_schema}` |
| params 字段 | snake_case | `target_asset` / `require_approval` |
| 输出字段 | snake_case | `risk_level` / `matched_rule_name` |

---

## 2. 统一调度入口

### 2.1 invoke_tool 函数签名

```python
# python-sidecar/tools/__init__.py
def invoke_tool(name: str, params: dict[str, Any]) -> dict[str, Any]:
    """统一工具调用入口（按 name 路由到对应 invoke 函数）

    Args:
        name: 工具名（risk / confidence / ground / decision / credibility / history）
        params: 工具参数（dict）

    Returns:
        工具返回结果（dict，schema 见各 tool 的 output_schema）

    Raises:
        KeyError: 未知工具名（包含 available 列表）
        ValueError: 工具参数校验失败（由具体工具抛出）
    """
    if name not in TOOL_REGISTRY:
        raise KeyError(
            f"unknown tool: '{name}', available: {list(TOOL_REGISTRY.keys())}"
        )
    return TOOL_REGISTRY[name](params)
```

### 2.2 调用时序

```
 Agent.invoke(state)
        │
        ▼
 select_tool(task, state) → {"tool_name": "risk", "params": {...}}
        │
        ▼
 call_tool(name, params)
        │
        ▼
 ┌──────────────────────────────────────────────────────────┐
 │  1. 校验 name in self.tools（可用工具列表）              │
 │  2. 延迟导入 from tools import invoke_tool              │
 │  3. invoke_tool(name, params)                            │
 │  4. 包装返回值：                                          │
 │     {tool_name, params, result, duration, success}       │
 │  5. 异常时返回 {success: False, error: str}              │
 └──────────────────────────────────────────────────────────┘
        │
        ▼
 format_observation(tool_call_result, state)
        │
        ▼
 推送 agent_message 事件到 event_bus
```

### 2.3 BaseAgent.call_tool 实现

```python
# python-sidecar/agents/base.py
def call_tool(self, name: str, params: dict[str, Any]) -> dict[str, Any]:
    """调用 MCP tool（通过 tools.invoke_tool 统一入口）"""
    start_time = time.time()
    self._stats["tool_calls"] += 1

    # 校验工具是否在可用列表（仅警告，不拦截）
    if name not in self.tools:
        logger.warning(f"agent {self.name} calling unauthorized tool: {name}")

    try:
        from tools import invoke_tool
        result = invoke_tool(name, params)
        duration = time.time() - start_time
        return {
            "tool_name": name,
            "params": params,
            "result": result,
            "duration": round(duration, 3),
            "success": True,
        }
    except Exception as e:
        duration = time.time() - start_time
        logger.exception(f"tool call failed: {name}, error={e}")
        return {
            "tool_name": name,
            "params": params,
            "result": {"error": str(e)},
            "duration": round(duration, 3),
            "success": False,
            "error": str(e),
        }
```

---

## 3. Tool 1: risk — 风险评估

### 3.1 用途

评估 Shell 命令的风险等级（4 层风控管道 → L0-L4），决定是否需要用户审批。

### 3.2 输入 schema

```json
{
  "command": "sudo systemctl restart nginx",   // 必填
  "target_asset": "demo-nginx",                 // 可选，目标资产名
  "context": {"agent": "main"}                  // 可选，保留字段
}
```

### 3.3 输出 schema

```json
{
  "level": "L3",                                // L0-L4
  "risk_level": "high",                         // low / medium / high / deny
  "reason": "sudo + systemctl + restart",
  "require_approval": true,
  "require_audit_log": false,
  "is_irreversible": false,
  "syntax_valid": true,
  "syntax_error": "",
  "matched_rule_name": "systemctl_restart",
  "target_asset": "demo-nginx",
  "environment_criticality": "medium",
  "adjusted_risk_level": "high"
}
```

### 3.4 4 层风控管道

```
 输入: command + target_asset
        │
        ▼
 ┌────────────────────────────────────────────────────────┐
 │  Layer 1: 语法校验 (Syntax Validation)                 │
 │  - Shell 语法解析（shellpy / shlex）                   │
 │  - 输出: syntax_valid / syntax_error                   │
 └────────────────┬───────────────────────────────────────┘
                  │
                  ▼
 ┌────────────────────────────────────────────────────────┐
 │  Layer 2: 规则匹配 (Rule Matching)                     │
 │  - 加载 config/risk_rules.yaml                          │
 │  - 关键词 + 正则 + 命令分类匹配                          │
 │  - 输出: matched_rule_name / risk_level                 │
 └────────────────┬───────────────────────────────────────┘
                  │
                  ▼
 ┌────────────────────────────────────────────────────────┐
 │  Layer 3: 确认需求 (Confirmation Requirement)          │
 │  - L3+ 风险 → require_approval = True                  │
 │  - L4 (deny) → 直接拒绝                                │
 │  - 输出: require_approval / require_audit_log           │
 └────────────────┬───────────────────────────────────────┘
                  │
                  ▼
 ┌────────────────────────────────────────────────────────┐
 │  Layer 4: 审计日志 (Audit Logging)                     │
 │  - L2+ 风险 → require_audit_log = True                 │
 │  - 不可逆操作（rm -rf） → is_irreversible = True        │
 │  - 输出: is_irreversible                                │
 └────────────────┬───────────────────────────────────────┘
                  │
                  ▼
 输出: 完整风险评估结果（含 L0-L4 + 11 个字段）
```

### 3.5 风险等级映射

| L0-L4 | risk_level | 含义 | require_approval | 示例 |
|-------|-----------|------|------------------|------|
| L0 | low | 安全 | False | `ls -l` / `cat file` |
| L1 | low | 低风险 | False | `grep -r pattern /` |
| L2 | medium | 中等 | True | `systemctl status nginx` |
| L3 | high | 高风险 | True | `sudo systemctl restart nginx` |
| L4 | deny | 禁止 | True（强制拒绝） | `rm -rf /` / `dd if=/dev/zero of=/dev/sda` |

### 3.6 错误处理

```python
# 参数校验失败
invoke_risk_tool({})  # 抛出 ValueError: command is required
invoke_risk_tool({"command": 123})  # ValueError: command must be str
```

---

## 4. Tool 2: confidence — 置信度融合

### 4.1 用途

将多个证据源（如 LLM 输出、规则匹配、知识库检索）融合为一个 0-1 的置信度分数。

### 4.2 输入 schema

```json
{
  "evidence": [
    {"source": "llm", "value": 0.85, "weight": 1.0},
    {"source": "rule", "value": 0.92, "weight": 0.8},
    {"source": "ground", "value": 0.78, "weight": 0.6}
  ],
  "method": "ds_pcr5"  // 可选，默认 D-S+PCR5
}
```

### 4.3 输出 schema

```json
{
  "score": 0.86,
  "method": "D-S+PCR5",
  "evidence_count": 3,
  "uncertainty": 0.14,
  "breakdown": {
    "llm": 0.85,
    "rule": 0.92,
    "ground": 0.78
  }
}
```

### 4.4 融合算法

```
 输入: evidence[] (多个证据源)
        │
        ▼
 ┌────────────────────────────────────────────┐
 │  Step 1: Dempster-Shafer 证据理论          │
 │  - 每个证据转为 mass 函数                  │
 │  - 计算冲突系数 K                          │
 │  - 正交求和 m1 ⊕ m2 ⊕ ... ⊕ mn            │
 └────────────┬───────────────────────────────┘
              │
              ▼
 ┌────────────────────────────────────────────┐
 │  Step 2: PCR5 冲突重新分配                 │
 │  - 高冲突时（K > 0.5）PCR5 重新分配        │
 │  - 避免冲突证据相互抵消                    │
 └────────────┬───────────────────────────────┘
              │
              ▼
 输出: score (0-1) + uncertainty (1 - score)
```

### 4.5 应用场景

- LLM 给出 0.85 置信度，规则匹配 0.92，知识库 0.78 → 融合后 0.86
- 决策时若 score < 0.6，触发 `needs_you.request_question` 询问用户

---

## 5. Tool 3: ground — 知识接地

### 5.1 用途

从知识库（ChromaDB 向量库 + SQLite FTS5 关键词索引）双路检索知识，避免 LLM 幻觉。

### 5.2 输入 schema

```json
{
  "query": "如何重启 nginx 服务",
  "top_k": 5,                       // 可选，默认 5
  "min_score": 0.6,                 // 可选，最低相似度
  "sources": ["tdsf.md", "man_nginx"]  // 可选，限定来源
}
```

### 5.3 输出 schema

```json
{
  "results": [
    {
      "content": "sudo systemctl restart nginx",
      "source": "tdsf.md",
      "score": 0.92,
      "metadata": {"section": "nginx-troubleshooting", "line": 45}
    },
    {
      "content": "nginx -s reload (平滑重载)",
      "source": "man_nginx",
      "score": 0.85,
      "metadata": {"section": "signals", "line": 12}
    }
  ],
  "sources": ["tdsf.md", "man_nginx"],
  "total": 2,
  "query": "如何重启 nginx 服务"
}
```

### 5.4 双路检索流程

```
 输入: query (自然语言)
        │
        ├──────────────────┬──────────────────┐
        ▼                  ▼                  ▼
 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 │ 向量检索      │  │ 关键词检索    │  │ 元数据过滤    │
 │ (ChromaDB)   │  │ (SQLite FTS5)│  │ (sources)    │
 │              │  │              │  │              │
 │ embedding    │  │ MATCH query  │  │ WHERE source │
 │ similarity   │  │ AGAINST      │  │ IN (...)     │
 └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
        │                  │                  │
        └──────────────────┴──────────────────┘
                           │
                           ▼
 ┌────────────────────────────────────────────┐
 │  融合排序 (Reciprocal Rank Fusion)         │
 │  score = 1 / (60 + rank_vector) +          │
 │          1 / (60 + rank_keyword)           │
 └────────────┬───────────────────────────────┘
              │
              ▼
 输出: top_k 结果 + score + source
```

### 5.5 知识库构成

| 来源 | 内容 | 更新方式 |
|------|------|----------|
| `tdsf.md` | TDSF 指令文件（用户自定义） | 文件 watcher 自动重载 |
| `man_*` | Linux man 页摘要 | 启动时索引 |
| `internal_kb` | 内置运维知识 | 静态打包 |

---

## 6. Tool 4: decision — 决策引擎

### 6.1 用途

综合风险等级、置信度、历史案例，输出最终决策（proceed / wait / abort / escalate）。

### 6.2 输入 schema

```json
{
  "command": "sudo systemctl restart nginx",
  "risk_level": "L3",                // 来自 risk tool
  "confidence": 0.86,                // 来自 confidence tool
  "history_outcomes": ["success", "success", "failure"],  // 可选
  "context": {"agent": "main"}
}
```

### 6.3 输出 schema

```json
{
  "decision": "proceed_with_approval",
  "alternatives": ["proceed", "abort", "wait"],
  "reasoning": "L3 风险需审批，置信度 0.86 高于阈值 0.7，历史成功率 67%",
  "confidence_score": 0.86,
  "risk_level": "L3",
  "recommended_mode": "agent",
  "escalation_needed": false
}
```

### 6.4 决策矩阵

| 风险等级 | 置信度 ≥ 0.8 | 置信度 0.6-0.8 | 置信度 < 0.6 |
|---------|-------------|---------------|--------------|
| L0-L1 | proceed | proceed | wait |
| L2 | proceed | proceed_with_caution | wait |
| L3 | proceed_with_approval | proceed_with_approval | escalate |
| L4 | abort | abort | abort |

### 6.5 决策值含义

| decision | 含义 | 后续动作 |
|----------|------|----------|
| `proceed` | 直接执行 | act_node 调用工具 |
| `proceed_with_caution` | 谨慎执行 | 记录审计日志 |
| `proceed_with_approval` | 需审批 | permission_check → needs_you |
| `wait` | 等待更多信息 | needs_you.request_question |
| `abort` | 终止 | reflect_node → next_step=error |
| `escalate` | 升级处理 | needs_you.request_handoff |

---

## 7. Tool 5: credibility — 可信度评估

### 7.1 用途

三维度评估信息来源的可信度：来源权威性 + 时效性 + 一致性。

### 7.2 输入 schema

```json
{
  "source": "stack_overflow",
  "content": "Use rm -rf to clean up",
  "timestamp": "2024-01-15T10:30:00Z",  // 内容发布时间
  "context": {"agent": "teach"}
}
```

### 7.3 输出 schema

```json
{
  "credibility": 0.65,
  "factors": {
    "source": 0.7,        // 来源权威性
    "timeliness": 0.5,    // 时效性
    "consistency": 0.75   // 一致性
  },
  "warnings": [
    "内容发布于 2 年前，可能过时",
    "建议与官方文档交叉验证"
  ],
  "recommend_verification": true
}
```

### 7.4 三维度评估

```
 来源权威性 (source)
   - 官方文档（man / docs）: 0.9-1.0
   - stack_overflow 高赞: 0.7-0.8
   - 个人博客: 0.4-0.6
   - 未知来源: 0.2-0.3

 时效性 (timeliness)
   - 1 个月内: 1.0
   - 6 个月内: 0.8
   - 1 年内: 0.6
   - 2 年以上: 0.4
   - 5 年以上: 0.2

 一致性 (consistency)
   - 与知识库一致: 1.0
   - 部分一致: 0.7
   - 不一致: 0.3
   - 无法验证: 0.5

 最终: credibility = (source + timeliness + consistency) / 3
       若任一 < 0.3 → recommend_verification = True
```

---

## 8. Tool 6: history — 历史案例

### 8.1 用途

从 SQLite 历史库检索过往类似命令的执行结果，辅助决策。

### 8.2 输入 schema（按 action 区分）

```json
// action: "search"（搜索历史案例）
{
  "action": "search",
  "query": "nginx restart",
  "limit": 10,
  "filters": {
    "success_only": false,
    "time_range": "7d"
  }
}

// action: "record"（记录新案例）
{
  "action": "record",
  "command": "sudo systemctl restart nginx",
  "outcome": "success",
  "duration": 1.2,
  "context": {"session_id": "sess-123"}
}

// action: "stats"（统计）
{
  "action": "stats",
  "group_by": "command_pattern"
}
```

### 8.3 输出 schema

```json
// search 结果
{
  "records": [
    {
      "id": 42,
      "command": "sudo systemctl restart nginx",
      "outcome": "success",
      "duration": 1.2,
      "timestamp": "2026-07-26T10:30:00Z",
      "session_id": "sess-123",
      "risk_level": "L3"
    }
  ],
  "total": 1,
  "query": "nginx restart"
}

// record 结果
{
  "id": 43,
  "recorded": true
}

// stats 结果
{
  "total_records": 156,
  "success_rate": 0.87,
  "by_pattern": [
    {"pattern": "systemctl restart", "count": 23, "success_rate": 0.91},
    {"pattern": "rm -rf", "count": 5, "success_rate": 1.0}
  ]
}
```

### 8.4 数据表结构

```sql
-- python-sidecar/data/history.db
CREATE TABLE history_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    command_pattern TEXT,           -- 命令模板（如 "systemctl restart <service>"）
    outcome TEXT NOT NULL,           -- success / failure / aborted
    duration REAL,
    risk_level TEXT,
    session_id TEXT,
    context JSON,
    timestamp TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_command_pattern ON history_records(command_pattern);
CREATE INDEX idx_timestamp ON history_records(timestamp);
```

---

## 9. Agent 调用 Tools 完整时序

### 9.1 单次工具调用流程

```
 graph/nodes.py act_node(state)
        │
        ▼
 agent.select_tool(task, state)
   → {"tool_name": "risk", "params": {"command": "sudo systemctl restart nginx"}}
        │
        ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  graph/nodes.py tool_call_node(state)                        │
 │                                                              │
 │  1. 从 state.tool_call_request 取 tool_name + params         │
 │  2. 调用 tools.invoke_tool(name, params)                     │
 │  3. 包装为 tool_call_result:                                 │
 │     {tool_name, params, result, duration, success}           │
 │  4. 写入 state.tool_call_result                              │
 │  5. 推送 agent_message 事件                                  │
 └──────────────────────────────────────────────────────────────┘
        │
        ▼
 permission_check_node(state)
   - 提取 result.level (L0-L4)
   - 调用 permissions.check_permission(mode, risk_level)
   - 决策：allow / require_approval / deny
        │
        ▼
 observe_node(state)
   - agent.format_observation(tool_call_result, state)
   - 追加到 intermediate_results
```

### 9.2 多工具协作示例（nginx 故障排查）

```
 用户输入: "nginx 启动失败"

 Step 1: risk tool
   params: {"command": "systemctl status nginx"}
   result: {level: "L2", require_approval: True}
        │
        ▼
 Step 2: permission_check
   mode="agent", risk="L2" → require_approval
        │
        ▼
 Step 3: needs_you.request_approval (用户审批)
        │
        ▼ (用户批准后)
 Step 4: 执行 systemctl status nginx
   → 输出: "Active: failed (Result: exit-code)"
        │
        ▼
 Step 5: ground tool
   params: {"query": "nginx failed to start exit-code"}
   result: {results: [{content: "检查 nginx -t 配置语法", score: 0.92}]}
        │
        ▼
 Step 6: history tool
   params: {"action": "search", "query": "nginx failed"}
   result: {records: [{command: "nginx -t", outcome: "success"}]}
        │
        ▼
 Step 7: confidence tool
   params: {evidence: [{source: "ground", value: 0.92}, ...]}
   result: {score: 0.88}
        │
        ▼
 Step 8: decision tool
   params: {command: "nginx -t", risk_level: "L1", confidence: 0.88}
   result: {decision: "proceed"}
        │
        ▼
 Step 9: 执行 nginx -t
   → 输出: "nginx: configuration file /etc/nginx/nginx.conf test failed"
        │
        ▼
 Step 10: reflect_node → next_step="done"
   最终观察: "nginx.conf 第 45 行语法错误"
```

---

## 10. 工具元数据（供 LLM Function Calling）

### 10.1 TOOL_METADATA 结构

```python
# python-sidecar/tools/risk.py
TOOL_METADATA: dict[str, Any] = {
    "name": "risk",
    "description": (
        "风险评估：4 层风控管道（语法/规则/确认/审计），"
        "输出 L0-L4 风险等级 + 是否需要审批。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "待评估的命令（必填）"},
            "target_asset": {"type": "string", "description": "目标资产名称（可选）"},
            "context": {"type": "object", "description": "上下文信息（可选，保留）"},
        },
        "required": ["command"],
    },
    "output_schema": {
        "type": "object",
        "properties": {
            "level": {"type": "string", "enum": ["L0", "L1", "L2", "L3", "L4"]},
            "risk_level": {"type": "string", "enum": ["low", "medium", "high", "deny"]},
            "reason": {"type": "string"},
            "require_approval": {"type": "boolean"},
            # ... 共 11 个字段
        },
    },
}
```

### 10.2 元数据查询接口

```python
# python-sidecar/tools/__init__.py
def get_tool_metadata(name: str) -> dict[str, Any]:
    """获取指定工具的元数据（含 input_schema / output_schema）"""

def list_tools() -> list[str]:
    """列出所有已注册的工具名"""
```

### 10.3 OpenAI Function Calling 集成

```python
# 转换为 OpenAI tools 参数
def to_openai_tools() -> list[dict]:
    """将 6 个 tool 的 metadata 转为 OpenAI function calling 格式"""
    return [
        {
            "type": "function",
            "function": {
                "name": meta["name"],
                "description": meta["description"],
                "parameters": meta["input_schema"],
            }
        }
        for name in list_tools()
        for meta in [get_tool_metadata(name)]
    ]
```

---

## 11. 错误处理与回退

### 11.1 错误分类

| 错误类型 | 触发场景 | 处理方式 |
|---------|----------|----------|
| `KeyError` | 未知工具名 | Agent 日志 warning，next_step=error |
| `ValueError` | 参数校验失败 | Agent 日志 warning，next_step=error |
| `RuntimeError` | 工具内部错误（如 ChromaDB 不可达） | 返回 `{error: str}`，success=False |
| `TimeoutError` | 工具执行超时（如 LLM 调用） | 30s 超时，返回 timeout 错误 |

### 11.2 回退策略

```python
# graph/nodes.py tool_call_node 的 mock 回退
def tool_call_node(state: AgentState) -> dict:
    request = state.get("tool_call_request", {})
    tool_name = request.get("tool_name", "unknown")

    try:
        from tools import invoke_tool
        result = invoke_tool(tool_name, params)
    except Exception as e:
        # 回退到 mock 实现（避免图执行中断）
        logger.warning(f"tool_call failed, fallback to mock: {e}")
        result = _mock_tool(tool_name, params)
```

### 11.3 单例模式与重置

```python
# 每个 tool 模块提供单例 + reset
_engine_instance: RiskEngine | None = None

def get_risk_engine(force_rebuild: bool = False) -> RiskEngine:
    """懒加载单例"""
    global _engine_instance
    if _engine_instance is None or force_rebuild:
        _engine_instance = RiskEngine(...)
    return _engine_instance

def reset_risk_engine() -> None:
    """重置单例（测试用）"""
    global _engine_instance
    _engine_instance = None
```

---

## 12. 测试策略

### 12.1 单元测试覆盖

| 测试文件 | 覆盖工具 | 测试数 |
|---------|----------|--------|
| `tests/test_risk_engine.py` | risk | 28 |
| `tests/test_confidence.py` | confidence | 18 |
| `tests/test_decision_engine.py` | decision | 22 |
| `tests/test_tools.py` | 6 tools 集成 | 35 |
| **合计** | — | **103** |

### 12.2 测试用例示例

```python
# tests/test_tools.py
def test_invoke_risk_tool_high_risk():
    """L3 风险命令应返回 require_approval=True"""
    result = invoke_risk_tool({"command": "sudo systemctl restart nginx"})
    assert result["level"] == "L3"
    assert result["require_approval"] is True

def test_invoke_tool_unknown():
    """未知工具应抛出 KeyError"""
    with pytest.raises(KeyError, match="unknown tool"):
        invoke_tool("nonexistent", {})
```

---

## 13. 性能与并发

### 13.1 工具执行耗时基线

| 工具 | 平均耗时 | 备注 |
|------|----------|------|
| `risk` | < 5ms | 规则匹配，无 IO |
| `confidence` | < 2ms | 纯计算 |
| `ground` | 50-200ms | ChromaDB 查询 |
| `decision` | < 5ms | 矩阵查表 |
| `credibility` | < 5ms | 规则计算 |
| `history` | 10-50ms | SQLite 查询 |

### 13.2 线程安全

- 所有 tool 入口函数 **无状态**（params in → result out）
- 内部单例（如 RiskEngine）使用 **模块级变量**（GIL 保护）
- ChromaDB / SQLite 连接 **每次请求新建**（避免连接共享）

### 13.3 缓存策略

- `risk_rules.yaml` 加载后缓存（force_rebuild 才重载）
- ChromaDB embedding 模型启动时加载（懒加载）
- SQLite 使用 WAL 模式（并发读不阻塞）

---

## 14. 版本兼容性

### 14.1 工具版本

| 工具 | 版本 | 状态 |
|------|------|------|
| risk | v1.0.0 | ✅ 稳定 |
| confidence | v1.0.0 | ✅ 稳定 |
| ground | v1.0.0 | ✅ 稳定 |
| decision | v1.0.0 | ✅ 稳定 |
| credibility | v1.0.0 | ✅ 稳定 |
| history | v1.0.0 | ✅ 稳定 |

### 14.2 Schema 兼容性策略

- output 字段 **只增不减**（新增字段不影响旧消费者）
- input 必填字段 **不可新增**（可选字段可以新增）
- 字段类型 **不可变更**（如 level 始终为 string）

---

## 15. 安全考量

### 15.1 输入校验

- 所有 tool 入口校验 `params` 类型为 dict
- 必填字段缺失 → `ValueError`
- 字段类型错误 → `ValueError`（含期望类型与实际类型）

### 15.2 命令注入防护

- `risk` tool 仅评估命令字符串，**不执行命令**
- 命令执行由 `act_node` 在 `permission_check` 通过后调用 PTY / 沙箱执行

### 15.3 数据库安全

- SQLite 使用参数化查询（防 SQL 注入）
- ChromaDB query 参数转义
- 历史记录的 `context` 字段使用 JSON 序列化（防注入）

---

## 16. 调试技巧

### 16.1 单工具独立测试

```bash
cd python-sidecar
python -c "
from tools import invoke_risk_tool
result = invoke_risk_tool({'command': 'sudo rm -rf /'})
print(result)
"
# 输出: {level: 'L4', risk_level: 'deny', require_approval: True, ...}
```

### 16.2 工具元数据查询

```python
from tools import list_tools, get_tool_metadata
print(list_tools())  # ['risk', 'confidence', 'ground', 'decision', 'credibility', 'history']
print(get_tool_metadata('risk'))
```

### 16.3 单例重置（测试隔离）

```python
from tools.risk import reset_risk_engine
reset_risk_engine()  # 清除缓存的单例，下次调用重新构建
```

---

## 17. 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| v1.0.0 | 2026-07-26 | 初始版本：6 个 MCP tools 完整接口契约 + 调度入口 + 元数据 + 错误处理 |

---

## 18. 参考文档

- `specs/04-api-contract.md`：API 契约规范（tool 输出格式权威来源）
- `python-sidecar/tools/__init__.py`：工具注册表
- `python-sidecar/tools/risk.py`：risk tool 实现
- `python-sidecar/core/risk_engine.py`：RiskEngine 核心
- `python-sidecar/agents/base.py`：BaseAgent.call_tool
- `python-sidecar/graph/nodes.py`：tool_call_node / act_node
- `specs/02-architecture.md` 第 3 节：MCP tools 架构
