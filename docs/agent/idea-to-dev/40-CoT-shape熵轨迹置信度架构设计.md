# CoT-shape 熵轨迹置信度架构设计（v0.9.6 P2 M4）

> **目标项目**：tdsf-linux-desktop v0.9.6
> **设计日期**：2026-07-20
> **作者**：trae-agent
> **依据论文**：Zhao 2026, arXiv:2603.18940（v0.9.6 P2 M4 新增）
> **关联模块**：可信度算法 S3（AI 参数证据）补强
> **关联调研**：[22-可信度算法论文支撑调研.md](./22-可信度算法论文支撑调研.md) §6.3.3、[35-可信度模块开发进度与论文支撑总表.md](./35-可信度模块开发进度与论文支撑总表.md) v1.5

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [论文依据](#2-论文依据)
3. [核心算法设计](#3-核心算法设计)
4. [与现有 AI 证据融合策略](#4-与现有-ai-证据融合策略)
5. [实现细节](#5-实现细节)
6. [类型与 IPC 传输](#6-类型与-ipc-传输)
7. [测试覆盖](#7-测试覆盖)
8. [效果评估与限制](#8-效果评估与限制)
9. [下一步计划](#9-下一步计划)
10. [参考文献](#10-参考文献)

---

## 1. 背景与动机

### 1.1 现状问题

v0.9.6 P1 阶段，可信度算法的 S3（AI 参数证据）已集成 3 个标量信号：

| 信号 | 来源 | 典型范围 | 论文依据 |
|------|------|---------|---------|
| **Verbalized Confidence** | LLM 自评（prompt "你的置信度是多少？"） | [0, 1] | Tian 2023, Lin 2022 |
| **Logprob Confidence** | API top logprobs 平均 | [0, 1] | Guerreiro 2022 |
| **Self-Consistency** | N 次采样语义聚类一致率 | [0, 1] | Wang 2023, ICLR |

**核心缺陷**：
- 这 3 个信号都是**单点标量**（scalar value），只反映 LLM 最终答案的"自信程度"
- 缺失 LLM **推理过程**的"形状"信息（reasoning trace shape）
- 对 reasoning model（DeepSeek-R1 / OpenAI o1）尤其不友好：CoT 推理过程长且多步，单点置信度无法捕捉推理质量

### 1.2 解决方案

引入 **CoT-shape 熵轨迹信号**（v0.9.6 P2 M4 新增）：
- 提取 LLM 在 Chain-of-Thought 推理过程中**每步的 Shannon 熵**
- 分析**熵轨迹的形状单调性**（entropy trajectory monotonicity）
- 作为**第 4 个"形状信号"**叠加在 3 路标量融合之后

---

## 2. 论文依据

### 2.1 核心论文：Zhao 2026

**Zhao, X. 2026**, "Entropy Trajectory Shape Predicts LLM Reasoning Reliability"
- arXiv:2603.18940v1, 2026-03-19

#### 2.1.1 核心发现

论文用 12 个 LLM × 6 个 benchmark 做实验，关键结果：

| 指标 | 数值 | 含义 |
|------|------|------|
| **单调链准确率** | 68.8% | 推理过程中熵**单调非递增**的链 |
| **非单调链准确率** | 46.8% | 推理过程中熵**存在反弹**的链 |
| **准确率 gap** | +21.9 pp | 形状单调性带来的准确率提升 |
| **比值比（OR）** | 2.50 | 单调链的"正确概率"是 2.5 倍 |
| **Fisher 检验 p 值** | 0.0005 | 强统计显著性 |
| **复制验证（Mistral-7B）** | 72.3% vs 37.6% | 跨模型可复现（OR=4.33） |
| **计算成本** | ~1,500 tokens/q | 远低于 self-consistency 的 ~40,000 tokens/q |

#### 2.1.2 关键解耦

论文另一个反直觉的发现：**标量总熵减少**对最终正确性**几乎无预测力**：

| 指标 | 标量总熵减少 | 形状单调性 |
|------|------------|----------|
| 与最终正确性相关系数 ρ | **−0.06**（p=0.31） | **0.52**（p<0.001） |
| 预测力 | 弱（统计不显著） | 强（统计显著） |

**启示**：不能用"开始到结束熵减少多少"作为预测因子，必须用"熵的轨迹形状"。

#### 2.1.3 违规数 → 准确率映射（Table 1）

论文 Table 1 给出违规计数与准确率的精确关系：

| 违规步数 | 准确率 | 我们的 conf 映射 |
|---------|-------|----------------|
| 0 | 68.8% | **0.85**（高信任） |
| 1 | 50.8% | **0.55**（中信任） |
| 2 | 28.6% | **0.30**（低信任） |
| ≥3 | 近似随机 | **0.10**（不信任） |

**我们使用论文经验数据做线性映射**（没有自己拟合训练）。

### 2.2 辅助论文

#### 2.2.1 Xu, T. et al. 2026 (ICML) "Unveiling the Entropy Dynamics of Chain-of-Thought Reasoning"

- **两阶段结构**：
  - Uncertainty Region（高熵探索，H > 阈值）
  - Confidence Region（熵崩收敛，H < 阈值）
- **CUSUM 检测转换点**：可触发 Early Exit，节省 11.1% tokens
- 准确率在 Confidence Region 跃升至 > 60%

**对我们的启示**：即使在 Xu 的两阶段模型下，"形状单调性"仍是质量信号（不是冗余）。

#### 2.2.2 Grünefeld et al. 2026 "Tracing Uncertainty in Language Model Reasoning" (arXiv:2605.07776)

- Uncertainty trace profile：少量特征描述不确定性信号的形状
- **早期正确性检测**：trace 早期特征可预测最终正确性

**对我们的启示**：CoT-shape 是 trace-level feature，不是 scalar-level，可与其他 trace-level 特征正交。

#### 2.2.3 Xu et al. ACL (OpenReview) "ETR: Entropy Trend Reward"

- 熵趋势（downward trend）vs 标量熵抑制的差异
- 推理效率与不确定性轨迹直接相关

**对我们的启示**：训练时用 entropy trend 作为 reward 信号；推理时仍可作为**质量信号**。

---

## 3. 核心算法设计

### 3.1 形式化定义

**输入**：CoT 熵轨迹 $\mathcal{H} = (H_0, H_1, \ldots, H_N)$，每步 $H_k \in [0, 1]$ 是 Shannon 熵归一化值。

**定义 1：单调非递增（monotone non-increasing）**

$$\text{monotone}(\mathcal{H}) \iff \forall k \in [0, N-1] : H_k \geq H_{k+1}$$

**定义 2：违规步数（violations）**

$$\text{violations}(\mathcal{H}) = \left| \{ k \in [0, N-1] : H_k < H_{k+1} \} \right|$$

**定义 3：置信度映射（基于 Zhao 2026 Table 1 经验数据）**

$$\text{confidence}(\mathcal{H}) = f(\text{violations}) = \begin{cases}
0.85 & \text{if } \text{violations} = 0 \\
0.55 & \text{if } \text{violations} = 1 \\
0.30 & \text{if } \text{violations} = 2 \\
0.10 & \text{if } \text{violations} \geq 3 \\
0.50 & \text{if } N = 0 \text{（空 trace）} \\
0.60 & \text{if } N = 1 \text{（单步 trace）}
\end{cases}$$

### 3.2 完整算法

```typescript
function analyzeCotEntropyTrajectory(trace: number[]): CotTraceAnalysis {
  // 边界 1：空 trace
  if (trace.length === 0) return { monotone: false, violations: 0, steps: 0, ..., confidence: 0.5 }
  
  // 边界 2：单步 trace
  if (trace.length === 1) return { monotone: true, violations: 0, steps: 1, ..., confidence: 0.6 }
  
  // 步骤 1：过滤非法值
  const clean = trace.map(clamp01)  // NaN/Infinity/负数 → 0；>1 → 1
  
  // 步骤 2：计算违规数
  let violations = 0
  for (let k = 0; k < clean.length - 1; k++) {
    if (clean[k] < clean[k + 1]) violations += 1
  }
  
  // 步骤 3：映射置信度
  const confidence = CONFIDENCE_BY_VIOLATIONS[Math.min(violations, 3)]
  
  return { monotone: violations === 0, violations, steps: clean.length, ..., confidence, summary }
}
```

**时间复杂度**：$O(N)$，$N$ 为 trace 长度（通常 5-50 步）

**空间复杂度**：$O(1)$（仅需常数空间计算违规数）

### 3.3 为什么不用"总熵减少"或"趋势斜率"？

| 备选方案 | 论文支持 | 缺陷 |
|---------|---------|------|
| 总熵减少 $\Delta H = H_0 - H_N$ | ❌ ρ=−0.06, p=0.31 | 与正确性**无显著相关** |
| 趋势斜率（最小二乘） | ⚠️ 部分论文用 | 比"违规计数"预测力弱（Zhao 2026 实验对比）|
| **单调性违规计数** | ✅ ρ=0.52, p<0.001 | **强预测因子**，且计算简单 |

**结论**：Zhao 2026 直接证明"违规计数" > "趋势斜率" > "标量总熵减少"，所以我们只实现违规计数。

---

## 4. 与现有 AI 证据融合策略

### 4.1 4 路信号融合公式

S3（AI 参数证据）从 v0.9.6 P1 的 3 路标量融合升级为 4 路融合：

```
步骤 1：llm_conf = verbalizedConfidence              # 标量（始终可用）
步骤 2：if logprob: llm_conf = 0.5·verb + 0.5·logprob   # 标量（API 支持时）
步骤 3：if consistency: llm_conf = 0.6·llm_conf + 0.4·consistency  # 标量（多次采样时）
步骤 3.5：if cotEntropyTrajectory:                   # 形状（P2 M4 新增）
            shapeConf = cotEntropyTrajectoryConfidence(trace)
            llm_conf = 0.7·llm_conf + 0.3·shapeConf
步骤 4：calibrated = applyTemperature(llm_conf, T_provider)  # 校准（P1）
步骤 5：m({T})  = 0.6 × calibrated                   # Mass 函数
        m({¬T}) = 0.2 × (1 - calibrated)
        m(Θ)   = 1 - m({T}) - m({¬T})
```

### 4.2 为什么 CoT-shape 用 0.3 权重？

| 候选权重 | 理由 | 风险 |
|---------|------|------|
| **0.5**（与标量信号等权） | 把 CoT-shape 当成"半路信号" | 压制标量信号；可能让 4 路平均 25% 时发挥不出 |
| **0.3**（推荐） | CoT-shape 是**独立预测因子**（OR=2.50），但仍是辅助信号 | ✅ 平衡标量与形状 |
| 0.2 | 保守策略 | CoT-shape 影响力不足 |
| 0.1 | 极保守 | 几乎无效 |

**选择 0.3 的理由**：
- 论文 OR=2.50 是"独立预测因子"（non-redundant），但不是"主导因子"（non-dominant）
- 标量信号（verb / logprob / consistency）已通过 3 步融合建立 baseline
- CoT-shape 应对 reasoning model（DeepSeek-R1 / o1）特别有效

### 4.3 CoT-shape 失败兜底

| 场景 | shapeConf | 实际效果 |
|------|-----------|---------|
| 不传 `cotEntropyTrajectory` | 跳过 | 保持 P1 行为（向后兼容） |
| 传 `undefined` | `cotEntropyTrajectoryConfidence` 返回 `null` | 跳过 |
| 传 `[]`（空数组） | 0.5（中性默认） | 0.7·llm_conf + 0.3·0.5 = 略偏移 |
| 传单步 `[0.7]` | 0.6 | 略偏移 |
| 传合法单调链 | 0.85 | 拉高 |
| 传合法非单调链 | 0.10/0.30/0.55 | 拉低 |
| 传非法值（NaN/Inf/越界） | 由 `analyzeCotEntropyTrajectory` 兜底为 [0, 1] | 优雅降级 |

**安全保证**：所有非法输入都不会让 `llm_conf` 越界到 [0, 1] 之外，因为 `cotEntropyTrajectoryConfidence` 的返回值已经在 [0, 1]。

---

## 5. 实现细节

### 5.1 文件结构

```
src/main/core/agent/credibility/mass-functions/
├── ai-param-source.ts          # v0.9.6 P1+P2 M4：4 路融合
└── cot-trace-signal.ts         # v0.9.6 P2 M4 新增：单调性 + 违规计数
```

### 5.2 关键 API

#### 5.2.1 `analyzeCotEntropyTrajectory(trace)` — 完整分析

```typescript
export function analyzeCotEntropyTrajectory(
  trace: CotEntropyTrajectory
): CotTraceAnalysis

interface CotTraceAnalysis {
  monotone: boolean          // 是否单调非递增
  violations: number         // 违反单调的步数
  steps: number              // trace 总步数
  startEntropy: number       // H_0
  endEntropy: number         // H_N
  totalReduction: number     // H_0 - H_N
  confidence: number         // [0, 1]，映射自 violations
  summary: string            // 人类可读摘要
}
```

#### 5.2.2 `cotEntropyTrajectoryConfidence(trace)` — 便捷标量

```typescript
export function cotEntropyTrajectoryConfidence(
  trace: CotEntropyTrajectory | undefined
): number | null
// 返回 null 当 trace 为 undefined
// 返回 confidence ∈ [0, 1] 当 trace 存在
```

### 5.3 与 calibration 解耦

CoT-shape 不影响 Temperature Scaling：
- T 仍然按 `reportedConfidence` 拟合（标量）
- CoT-shape 仅在 ai-param 融合时作为**辅助信号**
- 这样保证 calibration 行为对 reasoning model 友好（标量 → T → 校准后置信度），同时让 CoT-shape 提供独立预测力

### 5.4 性能开销

- 时间复杂度：$O(N)$，$N$ 通常 5-50 步
- 每次评估额外开销：< 1µs（仅几次比较）
- 内存开销：$O(N)$，但 trace 由 LLM 推理时已生成（无额外分配）

---

## 6. 类型与 IPC 传输

### 6.1 共享类型扩展

`src/shared/agent-types.ts` 新增字段：

```typescript
export interface CalibrationSample {
  // ... 原有字段
  /**
   * 可选：CoT 熵轨迹（v0.9.6 P2 M4 新增）
   * LLM 在 Chain-of-Thought 推理过程中每步的 Shannon 熵 ∈ [0, 1]
   */
  cotEntropyTrajectory?: number[]
}
```

### 6.2 IPC 传输注意

`CredibilityEvidenceInput.fields` 是 `Record<string, number | boolean>`，**不能直接放数组**。

**当前实现路径**：
1. 渲染进程收集 trace 后，通过**专用 IPC 通道**（如 `credibility:cot-trace`）传给主进程
2. 主进程侧直接调用 `createAiParamMassFunction({ ..., cotEntropyTrajectory: trace })`
3. 不走通用 `credibility:assess` IPC 通道（因为该通道的 fields 限制）

**未来扩展**（v0.9.7+）：将 `CredibilityEvidenceInput.fields` 升级为 `Record<string, number | boolean | number[] | string>`，支持 trace 数组直接走通用通道。

### 6.3 trace 数据来源

#### 6.3.1 Reasoning Model（DeepSeek-R1 / OpenAI o1）

Reasoning model 内部有 chain-of-thought 推理过程。每步推理完成后：
- **方法 1（推荐）**：从 response metadata 获取 token-level logprobs，计算每步 answer-distribution entropy
- **方法 2**：每隔 N tokens 采样一次 answer，计算 Shannon 熵
- **方法 3**：通过 hidden states（开源模型）计算 prediction entropy

#### 6.3.2 Non-Reasoning Model（GPT-4o / Claude）

非 reasoning model 不暴露 CoT 过程。可通过**外部 prompt 注入**模拟：
```
每回答一段后，请输出当前步骤的不确定性（0-1 之间的数字）。
```

但这种方法会增加 token 成本和延迟，**不建议生产使用**。

#### 6.3.3 tdsf-linux-desktop 的当前实际来源

v0.9.6 P2 M4 阶段，**主进程不主动收集 CoT 熵轨迹**。仅当上层调用方（如 ClaudeSdkProvider、supervisor）传入 `cotEntropyTrajectory` 时才参与融合。

**这是渐进式集成**：
- P2 M4：数据结构 + 融合逻辑（已完成）
- P2 M5+：在 ClaudeSdkProvider / supervisor 中实现 trace 收集

---

## 7. 测试覆盖

### 7.1 测试文件

| 文件 | 新增测试数 | 覆盖维度 |
|------|----------|---------|
| `tests/core/agent/credibility/cot-trace-signal.test.ts` | 20 | 论文 4 个核心场景 + 边界 + 便捷函数 + 可解释性 |
| `tests/core/agent/credibility/mass-functions.test.ts` | +8 | 4 路融合 + 拉高/拉低 + 单步 + 空 + 向后兼容 + mass 守恒 |
| **合计** | **28** | — |

### 7.2 关键测试用例

#### 7.2.1 论文核心场景

```typescript
// 场景 1：完美单调链 → conf=0.85
analyzeCotEntropyTrajectory([0.9, 0.7, 0.5, 0.3, 0.1])
// => { monotone: true, violations: 0, confidence: 0.85 }

// 场景 2：1 步违规 → conf=0.55
analyzeCotEntropyTrajectory([0.9, 0.5, 0.7, 0.3, 0.1])
// => { monotone: false, violations: 1, confidence: 0.55 }

// 场景 3：2 步违规 → conf=0.30
analyzeCotEntropyTrajectory([0.5, 0.7, 0.4, 0.6, 0.2])
// => { monotone: false, violations: 2, confidence: 0.30 }

// 场景 4：3+ 步违规 → conf=0.10
analyzeCotEntropyTrajectory([0.1, 0.9, 0.2, 0.8, 0.1, 0.7])
// => { monotone: false, violations: 3, confidence: 0.10 }
```

#### 7.2.2 4 路融合验证

```typescript
// verbalized=0.8, logprob=0.6, consistency=0.9, CoT 完美单调
const mf = createAiParamMassFunction({
  verbalizedConfidence: 0.8,
  logprobConfidence: 0.6,
  consistency: 0.9,
  cotEntropyTrajectory: [0.9, 0.7, 0.5, 0.3, 0.1],
})
// 步骤 1: 0.8
// 步骤 2: 0.5×0.8 + 0.5×0.6 = 0.7
// 步骤 3: 0.6×0.7 + 0.4×0.9 = 0.78
// 步骤 3.5: 0.7×0.78 + 0.3×0.85 = 0.801
// 步骤 4: 0.801 × 0.85 = 0.68085
// 期望 mf.confidence ≈ 0.68085
```

#### 7.2.3 边界与向后兼容

```typescript
// 不传 cotEntropyTrajectory → 保持 P1 行为
createAiParamMassFunction({ verbalizedConfidence: 0.5 }).confidence
// === 0.425（与 P1 完全一致）

// 空数组 → 中性默认
createAiParamMassFunction({ verbalizedConfidence: 0.5, cotEntropyTrajectory: [] }).confidence
// === 0.425（与不传一致）

// 单步 → conf=0.6
createAiParamMassFunction({ verbalizedConfidence: 0.5, cotEntropyTrajectory: [0.7] }).confidence
// === 0.4505（= (0.7×0.5 + 0.3×0.6) × 0.85）
```

### 7.3 测试运行结果

```
$ npx vitest run tests/core/agent/credibility/cot-trace-signal.test.ts tests/core/agent/credibility/mass-functions.test.ts

 ✓ tests/core/agent/credibility/cot-trace-signal.test.ts (20 tests) 4ms
 ✓ tests/core/agent/credibility/mass-functions.test.ts (49 tests) 9ms

 Test Files  2 passed (2)
      Tests  69 passed (69)
   Duration  1.79s
```

**全量测试结果**：

```
$ npx vitest run

 Test Files  46 passed (46)
      Tests  1073 passed (1073)
   Duration  20.30s
```

对比 P2 M7 (v1.4) 的 1045 个测试，**+28 个新测试**全部通过，**100% 通过率**。

---

## 8. 效果评估与限制

### 8.1 预期效果

基于 Zhao 2026 论文数据，CoT-shape 信号预期在以下场景提升可信度评估质量：

| 场景 | 当前（无 CoT-shape） | 加入 CoT-shape 后 | 提升来源 |
|------|--------------------|------------------|---------|
| DeepSeek-R1 / OpenAI o1（reasoning model） | 标量仅反映最终答案 | 额外捕捉推理过程形状 | 显著提升 |
| GPT-4o / Claude（非 reasoning） | 标量仅反映最终答案 | 无 CoT 时不参与 | 无影响（向后兼容）|
| 多次采样 model | 标量 + self-consistency | + CoT-shape 正交 | 中度提升 |

### 8.2 限制与注意事项

#### 8.2.1 trace 收集成本

| 模型类型 | trace 收集成本 | 推荐 |
|---------|--------------|------|
| Reasoning model（DeepSeek-R1） | 低（API 隐式提供） | ✅ 强烈推荐 |
| 开源 model（本地部署） | 中（需采样 hidden states） | ✅ 推荐 |
| 闭源非 reasoning（GPT-4o） | 高（需 prompt 注入） | ⚠️ 不推荐 |
| Claude（API） | ❌ 不暴露 logprobs | ❌ 不可用 |

#### 8.2.2 trace 长度的影响

- **短 trace（< 5 步）**：信息不足，置信度被 clamp 到 0.5/0.6（保守）
- **中等 trace（5-20 步）**：Zhao 2026 主要实验范围，最可靠
- **长 trace（> 50 步）**：仍然可用，但单步违规的边际影响变小（因为总违规数增加缓慢）

#### 8.2.3 与其他信号的潜在冲突

| 信号组合 | 潜在冲突 | 解决 |
|---------|---------|------|
| CoT-shape=0.85 + verbalized=0.2 | LLM "看起来推理好但说"我不确定" | CoT-shape 拉高（OR=2.50 论文支持）|
| CoT-shape=0.10 + verbalized=0.9 | LLM "自信但推理差" | CoT-shape 拉低（防止 hallucination）|
| 标量全 0.5 + CoT-shape=0.85 | 中性推理+好形状 | CoT-shape 拉高（合理）|

**核心设计原则**：CoT-shape 是"质量信号"，不是"自信信号"。当两者冲突时（如 verbalized 高但 CoT-shape 低），应**信任 CoT-shape**（因为论文证明其预测力更强）。

### 8.3 与 P1 calibration 的关系

- **不冲突**：calibration 仍然按 `reportedConfidence` 拟合 T（标量）
- **不冗余**：calibration 解决"标量置信度的标定问题"，CoT-shape 解决"推理质量的形状问题"
- **正交叠加**：calibration 在 CoT-shape 融合之后做（步骤 3.5 → 步骤 4）

```
verbalized → [+ logprob] → [+ consistency] → [+ CoT-shape] → [calibration T] → mass function
   P1        P1              P1               P2 M4 新增       P1
```

---

## 9. 下一步计划

### 9.1 P2 M5+：trace 收集实现

在 `ClaudeSdkProvider` 和 `supervisor` 中实现 trace 收集：

```typescript
// 伪代码
async function* collectEntropyTrace(prompt: string): AsyncGenerator<number> {
  const stream = await llm.stream(prompt, { includeLogprobs: true })
  let stepIndex = 0
  for await (const chunk of stream) {
    if (chunk.choices?.[0]?.logprobs) {
      const entropy = computeShannonEntropy(chunk.choices[0].logprobs)
      yield entropy
      stepIndex += 1
    }
  }
}
```

### 9.2 P2 M5+：DecisionCard 集成

在 DecisionCard 中显示 CoT-shape 诊断信息：
- 单调链：绿色徽章 "推理链稳定"
- 非单调链：黄色徽章 "推理链波动"
- 重度违规：红色徽章 "推理链混乱"

### 9.3 P2 M6+：DAG 可视化增强

在 v0.9.6 P2 M6 的 audit 报告中增加 CoT-shape 字段：
- `cotTraceShape: 'monotone' | 'non-monotone'`
- `cotViolations: number`
- `cotConfidence: number`

### 9.4 v0.9.7+：trace 长度自适应

当前算法对短 trace（< 5 步）保守（clamp 到 0.5/0.6）。未来可：
- 根据 trace 长度动态调整映射表
- 引入 Bayesian 先验（短 trace 时更保守）

---

## 10. 参考文献

### 10.1 核心论文

1. **Zhao, X. 2026**, "Entropy Trajectory Shape Predicts LLM Reasoning Reliability"
   - arXiv:2603.18940v1, 2026-03-19
   - 核心：单调链 vs 非单调链 +21.9 pp 准确率 gap，OR=2.50
   - 链接：https://arxiv.org/abs/2603.18940

2. **Xu, T. et al. 2026 (ICML)**, "Unveiling the Entropy Dynamics of Chain-of-Thought Reasoning"
   - 两阶段结构（Uncertainty Region / Confidence Region）
   - CUSUM 转换点检测 + Early Exit 节省 11.1% tokens

3. **Grünefeld et al. 2026**, "Tracing Uncertainty in Language Model Reasoning"
   - arXiv:2605.07776
   - Uncertainty trace profile + 早期正确性检测

4. **Xu et al. ACL (OpenReview)**, "ETR: Entropy Trend Reward"
   - 熵趋势（downward trend）vs 标量熵抑制

### 10.2 已有可信度论文（v0.9 → v0.9.6 P1）

5. **Guo et al. 2017**, "On Calibration of Modern Neural Networks", ICML
   - 过度自信 + Temperature Scaling
   - arXiv:1706.04599

6. **Tian et al. 2023**, "Just Ask for Calibration", EMNLP
   - Verbalized Confidence
   - Foresight 2023 paper

7. **Wang et al. 2023**, "Self-Consistency Improves Chain of Thought Reasoning", ICLR
   - 多次采样 + 语义聚类
   - CoT + self-consistency

8. **Shafer 1976**, "A Mathematical Theory of Evidence"
   - D-S 证据理论
   - Princeton University Press

9. **Smarandache & Dezert 2004/2021**, "PCR5: Proportional Conflict Redistribution Rule #5"
   - arXiv:cs.AI/0408064
   - 冲突处理（与本模块的 D-S 融合相关）

### 10.3 调研文档

- [22-可信度算法论文支撑调研.md](./22-可信度算法论文支撑调研.md) — 总体算法论文清单
- [35-可信度模块开发进度与论文支撑总表.md](./35-可信度模块开发进度与论文支撑总表.md) — 进度总表（v1.5）
- [39-v1.4-RTL组件测试调研报告.md](./39-v1.4-RTL组件测试调研报告.md) — 上一阶段调研

---

## 附录 A：架构总览图

```
┌─────────────────────────────────────────────────────────────┐
│                    S3: AI 参数证据 (v0.9.6 P2 M4)           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  输入层：                                                   │
│    ┌──────────────────┐                                     │
│    │ verbalizedConf   │ (Tian 2023, 始终可用)               │
│    └──────────────────┘                                     │
│    ┌──────────────────┐                                     │
│    │ logprobConf      │ (Guerreiro 2022, 可选)              │
│    └──────────────────┘                                     │
│    ┌──────────────────┐                                     │
│    │ consistency      │ (Wang 2023, 可选)                   │
│    └──────────────────┘                                     │
│    ┌──────────────────┐                                     │
│    │ cotEntropyTraj   │ (Zhao 2026, P2 M4 新增) ←─┐        │
│    └──────────────────┘                           │        │
│                                                    │        │
│  融合层：                                          │        │
│    步骤 1: llmConf = verb                          │        │
│    步骤 2: llmConf = 0.5·verb + 0.5·logprob        │        │
│    步骤 3: llmConf = 0.6·llmConf + 0.4·consist    │        │
│    步骤 3.5: llmConf = 0.7·llmConf + 0.3·shape ───┘        │
│              ↑                                              │
│              └─ shape = cotEntropyTrajectoryConfidence(t)   │
│                                                             │
│  校准层（P1）：                                             │
│    步骤 4: calibrated = applyTemperature(llmConf, T_prov)   │
│                                                             │
│  输出层（D-S Mass 函数）：                                  │
│    m({T})  = 0.6 × calibrated                               │
│    m({¬T}) = 0.2 × (1 - calibrated)                         │
│    m(Θ)   = 1 - m({T}) - m({¬T})                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                                 ↓
                    FusionEngine (Dempster/PCR5)
                                 ↓
                  ConfidenceAssessment (Bel/Pl/conf)
                                 ↓
                    DecisionCard + Audit Report
```

## 附录 B：测试覆盖率

| 模块 | 测试文件 | 测试数 | 状态 |
|------|---------|-------|------|
| CoT-shape 信号 | `cot-trace-signal.test.ts` | 20 | ✅ 100% |
| AI 参数 Mass 函数（含 CoT-shape 集成）| `mass-functions.test.ts` (S3 部分) | 16（原 8 + CoT-shape 8）| ✅ 100% |
| **合计 v0.9.6 P2 M4** | — | **28** | **✅ 100%** |
| 全量（credibility 相关）| 9 个测试文件 | 327 个 credibility 相关 | ✅ 100% |
| 全量（项目级）| 46 个测试文件 | **1073** | ✅ 100% |

---

**文档版本**：v0.9.6 P2 M4 — 2026-07-20
**作者**：trae-agent
**下次更新**：v0.9.6 P2 M5+（trace 收集实现）
