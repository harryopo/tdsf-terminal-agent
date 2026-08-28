# 运维 AI 决策可信度算法与多源证据融合调研方案书

> 调研时间：2026-07-17
> 调研范围：XAI 可解释算法 / 证据理论 / LLM 输出可信度 / 运维决策融合 / 论文检索 / Electron+React+TS 实现可行性
> 目标项目：Linux 教学 + 运维 AI 决策辅助（Electron + React + TypeScript）
> 任务定位：仅做调研与方案分析，不写代码

---

## 目录

- [0. TL;DR 推荐结论](#0-tldr-推荐结论)
- [1. 可解释 AI（XAI）可信度算法](#1-可解释-aixai可信度算法)
  - [1.1 SHAP](#11-shap)
  - [1.2 LIME](#12-lime)
  - [1.3 Attention Rollout / Attention Flow](#13-attention-rollout--attention-flow)
  - [1.4 对 LLM 输出可信度的适用性](#14-对-llm-输出可信度的适用性)
- [2. 证据理论与多源融合](#2-证据理论与多源融合)
  - [2.1 Dempster-Shafer 证据理论](#21-dempster-shafer-证据理论)
  - [2.2 主观逻辑（Subjective Logic）](#22-主观逻辑subjective-logic)
  - [2.3 模糊逻辑（Fuzzy Logic）](#23-模糊逻辑fuzzy-logic)
  - [2.4 贝叶斯网络（Bayesian Network）](#24-贝叶斯网络bayesian-network)
  - [2.5 四种理论横向对比](#25-四种理论横向对比)
- [3. LLM 输出可信度评估](#3-llm-输出可信度评估)
  - [3.1 logprob / token probability](#31-logprob--token-probability)
  - [3.2 自一致性采样投票](#32-自一致性采样投票self-consistency)
  - [3.3 置信度校准（Platt / Temperature Scaling）](#33-置信度校准platt--temperature-scaling)
  - [3.4 RAG 检索分数 → 可信度映射](#34-rag-检索分数--可信度映射)
  - [3.5 Chain-of-Thought 可信度传播](#35-chain-of-thought-可信度传播)
  - [3.6 推荐的 LLM 可信度组合信号](#36-推荐的-llm-可信度组合信号)
- [4. 运维决策可信度具体方案](#4-运维决策可信度具体方案)
  - [4.1 多源证据定义](#41-多源证据定义)
  - [4.2 加权融合公式](#42-加权融合公式)
  - [4.3 D-S 证据融合公式](#43-d-s-证据融合公式)
  - [4.4 贝叶斯融合公式](#44-贝叶斯融合公式)
  - [4.5 推荐混合方案（加权 + D-S + 风险阈值）](#45-推荐混合方案加权--d-s--风险阈值)
  - [4.6 可视化方案](#46-可视化方案)
  - [4.7 相关开源实现与论文参考](#47-相关开源实现与论文参考)
- [5. arXiv 近 2 年论文检索](#5-arxiv-近-2-年论文检索)
  - [5.1 Trustworthy LLM](#51-trustworthy-llm)
  - [5.2 Confidence Calibration](#52-confidence-calibration)
  - [5.3 Evidence-based Decision / 多源证据融合](#53-evidence-based-decision--多源证据融合)
  - [5.4 AIOps / 日志异常检测可信决策](#54-aiops--日志异常检测可信决策)
- [6. Electron + React + TypeScript 实现可行性](#6-electron--react--typescript-实现可行性)
- [7. 重点推荐算法（针对本项目）](#7-重点推荐算法针对本项目)
- [8. 参考来源](#8-参考来源)

---

## 0. TL;DR 推荐结论

针对本项目（运维 AI 决策可信度，Electron + React + TypeScript）的最佳组合：

1. **首推：D-S 证据理论 + 加权融合（混合方案）**
   - 理由：天然支持"日志 + 知识库 + 模型参数 + 人工决策 + 历史对话 + 最佳实践"六源异构证据，显式建模"无知"（uncertainty mass），可处理证据冲突，JS/TS 侧无重量级依赖即可纯 TS 实现。
   - 可视化匹配度：可直接驱动"证据链图 + 置信度仪表盘 + 风险等级色带"三件套。
2. **次推：主观逻辑（Subjective Logic）**
   - 当需要把每个证据源建模为 (belief, disbelief, uncertainty) 三元组、且需要"信任折扣"（trust discounting）传播人工/历史源可信度时，主观逻辑是 D-S 的精细化版本，更适合"多级信任链"场景。

LLM 侧可信度信号优先级（按落地成本/收益比）：
**self-consistency 投票 ≥ token logprob 校准 > CoT 步级熵轨迹 > RAG 检索分数 > 激活层置信度模型**。

---

## 1. 可解释 AI（XAI）可信度算法

### 1.1 SHAP

- **全称**：SHapley Additive exPlanations
- **论文**：Lundberg & Lee, *A Unified Approach to Interpreting Model Predictions*, NeurIPS 2017, arXiv:1705.07874
- **核心思想**：把合作博弈论中的 Shapley 值引入 ML 模型解释，将单条预测 $f(x)$ 分解为各特征的加性贡献 $\phi_i$，满足局部精确性、一致性、缺失性三大公理。
- **公式**：

  Shapley 值定义：

  $$
  \phi_i = \sum_{S \subseteq N \setminus \{i\}} \frac{|S|!\;(|N|-|S|-1)!}{|N|!} \bigl[ f(S \cup \{i\}) - f(S) \bigr]
  $$

  SHAP 加性归因：

  $$
  f(x) = \phi_0 + \sum_{i=1}^{M} \phi_i, \quad \phi_0 = \mathbb{E}[f(X)]
  $$

- **变体**：KernelSHAP（模型无关）、TreeSHAP（树模型高效解析解，Lundberg et al. 2020）、DeepSHAP（深度网络）。
- **官方实现**：Python `shap` 包（GitHub `shap/shap`，28k+ stars）。**无官方 JS/TS 实现**，需自行实现 KernelSHAP 近似或调用 Python sidecar。
- **可信度维度**：SHAP 给"为何这么预测"的特征归因，但 $\sum \phi_i$ 不直接等于"可信度"。可作为决策依据的**辅助解释层**，与置信度数值解耦。

### 1.2 LIME

- **全称**：Local Interpretable Model-agnostic Explanations
- **论文**：Ribeiro, Singh, Guestrin, *"Why Should I Trust You?: Explaining the Predictions of Any Classifier"*, KDD 2016, arXiv:1602.04938
- **核心思想**：在待解释样本 $x$ 邻域扰动生成 $Z$，用原黑盒模型 $f$ 打标 $\hat{y}_Z$，按相似度 $\pi_x$ 加权后拟合一个稀疏线性可解释模型 $g \in G$。
- **公式**：

  $$
  \xi(x) = \arg\min_{g \in G} \; \mathcal{L}\bigl(f, g, \pi_x\bigr) + \Omega(g)
  $$

  其中 $\mathcal{L}$ 是局部忠实度损失，$\Omega(g)$ 是模型复杂度惩罚（如稀疏 Lasso）。

- **官方实现**：Python `lime`（GitHub `marcotcr/lime`）。**无成熟 TS 实现**。
- **可信度维度**：LIME 解释的是"为何这样预测"，不是"预测多可信"。常与 SHAP 互为补充。

### 1.3 Attention Rollout / Attention Flow

- **论文**：Abnar & Zuidema, *"Quantifying Attention Flow in Transformers"*, ACL 2020
- **核心思想**：Transformer 原始 attention 权重跨层后已失真，需要"rollout"沿层累乘（结合残差）才能反映输入 token 对最终输出的真实贡献度。
- **公式**（带残差的 Attention Rollout）：

  $$
  \tilde{A}^{i} = \begin{cases} (0.5 A^{i} + 0.5 I), & i = 0 \\[4pt] (0.5 A^{i} + 0.5 I)\, \tilde{A}^{i-1}, & i > 0 \end{cases}
  $$

  $A^i$ 为第 $i$ 层注意力矩阵（多 head 平均后归一化），$I$ 为单位阵（残差项）。$\tilde{A}^{L}$ 的某行即对应输入 token 对最终输出的归因权重。

- **变体**：Attention Flow（最大流算法）、Gradient Attention Rollout（Chefer et al. 2021，对 ViT 类模型更准）。
- **可信度维度**：仅适用于 Transformer 类模型且能拿到 attention 权重的场景。对闭源 LLM API（GPT-4 / Claude）不可用——这是本项目主要限制。

### 1.4 对 LLM 输出可信度的适用性

| 方法 | 适用前提 | 对闭源 LLM 可用 | 推荐在本项目中的角色 |
|---|---|---|---|
| SHAP | 能反复 query 黑盒并扰动输入 | 部分（成本高） | 不主用，仅用于内部小模型（如日志分类器）解释 |
| LIME | 同上 | 部分（成本高） | 同上 |
| Attention Rollout | 能拿到 attention 矩阵 | 否 | 仅用于本地小 Transformer / Embedding 模型 |

**结论**：对闭源 LLM，XAI 三件套均不直接适用；对项目自训练的"日志分类/异常检测"小模型可用 SHAP/Attention Rollout 做**辅助解释**，但不能作为 LLM 输出本身的可信度来源。LLM 侧可信度应使用 [§3] 的概率/一致性信号。

---

## 2. 证据理论与多源融合

### 2.1 Dempster-Shafer 证据理论

- **奠基文献**：
  - Dempster, A. P. (1967). *Upper and Lower Probabilities Induced by a Multivalued Mapping*. Annals of Mathematical Statistics, 38(2).
  - Shafer, G. (1976). *A Mathematical Theory of Evidence*. Princeton University Press.
- **中文综述**：Lu & He, *Dempster-Shafer Evidence Theory and Study of Some Key Problems*, J. Electronic Science and Technology, 2017.

#### 核心概念

- **识别框架** $\Theta = \{\theta_1, \dots, \theta_n\}$，互斥且完备。
- **基本概率分配（BPA / mass）**：$m: 2^{\Theta} \to [0,1]$，满足
  $$
  m(\emptyset) = 0, \quad \sum_{A \subseteq \Theta} m(A) = 1
  $$
- **信任函数**：
  $$
  \operatorname{Bel}(A) = \sum_{B \subseteq A} m(B)
  $$
- **似然函数**：
  $$
  \operatorname{Pl}(A) = \sum_{B \cap A \neq \emptyset} m(B) = 1 - \operatorname{Bel}(\overline{A})
  $$
- **不确定性区间**：$[\operatorname{Bel}(A), \operatorname{Pl}(A)]$，区间越宽越"无知"。

#### Dempster 组合规则

对两个独立证据源 $m_1, m_2$：

$$
m_{1 \oplus 2}(A) = \frac{\displaystyle\sum_{B \cap C = A} m_1(B)\, m_2(C)}{1 - K}, \quad K = \sum_{B \cap C = \emptyset} m_1(B)\, m_2(C)
$$

- $K$ 为**冲突系数**，$K \to 1$ 时证据高度冲突，规则失效。
- 高冲突改进：Yager 规则、Smets TBM（未归一化）、**PCR5**（Proportional Conflict Redistribution，Dézert & Smarandache）。

#### 优势与局限

| 优势 | 局限 |
|---|---|
| 显式建模"无知"，区分"等概率"与"不知道" | 幂集规模 $2^n$ 指数增长 |
| 支持复合命题，比贝叶斯更灵活 | 高冲突（$K>0.5$）下结果反直觉 |
| 多源可逐步融合，无需先验 | 改进规则（PCR5/Yager）破坏结合律 |

### 2.2 主观逻辑（Subjective Logic）

- **奠基文献**：
  - Jøsang, A. (1997). *Trust Analysis with Subjective Logic*. Technical Report.
  - Jøsang, A. (2016). *Subjective Logic: A Formalism for Reasoning Under Uncertainty*. Springer.
- **核心思想**：把 D-S 限制在"单点子集 + 全集"上，引入四元组 **opinion** $\omega_x = (b, d, u, a)$：
  - $b$：belief（信度）
  - $d$：disbelief（不信度）
  - $u$：uncertainty（不确定度）
  - $a$：base rate（先验）

  满足 $b + d + u = 1$。

#### 关键公式

- **意见 ↔ 证据映射**（binomial case，与 Beta 分布一一对应）：

  $$
  (b, d, u) = \frac{(p, n, c)}{p + n + c}, \qquad (p, n) = \frac{c\,(b, d)}{u}
  $$

  其中 $(p, n)$ 为支持/反对证据量，$c$ 为单位证据常数（常取 $c=2$）。

- **累积融合（cumulative fusion $\oplus$）**：两独立观察者各自观察了不同证据，证据相加：

  $$
  \omega_{x \oplus y} = \left( \frac{x_u y_b + y_u x_b}{x_u + y_u - x_u y_u},\; \frac{x_u y_d + y_u x_d}{x_u + y_u - x_u y_u},\; \frac{x_u y_u}{x_u + y_u - x_u y_u} \right)
  $$

- **平均融合（averaging fusion $\oslash$）**：两观察者观察相同证据但解读不同，证据取均：

  $$
  \omega_{x \oslash y} = \left( \frac{x_b y_u + y_b x_u + x_b y_b}{x_u + y_u - x_u y_u},\; \ldots \right)
  $$

- **信任折扣（trust discounting $\otimes$）**：Alice 对 Bob 的信任 $\omega_{A \to B}$ 折扣 Bob 对命题 $P$ 的意见 $\omega_B^P$：

  $$
  \omega_{A \to B}^P = \bigl( b_{A \to B} \cdot b_B^P,\; b_{A \to B} \cdot d_B^P,\; d_{A \to B} + u_{A \to B} + b_{A \to B} \cdot u_B^P \bigr)
  $$

  这是"信任链传播"的核心算子，特别适合本项目"人工决策源"和"历史对话源"的可信度衰减。

- **概率投影**（用于决策）：
  $$
  P(x) = b + a \cdot u
  $$

#### 与 D-S 的关系

主观逻辑是 D-S 的特例（限制 mass 分配在单点和全集），但增加了 base rate 与完整代数算子，**工程上更易实现**（无需操作幂集）。

### 2.3 模糊逻辑（Fuzzy Logic）

- **奠基文献**：Zadeh, L. A. (1965). *Fuzzy Sets*. Information and Control, 8(3), 338–353.
- **核心思想**：用 $[0,1]$ 隶属度 $\mu_A(x)$ 表达"程度真"，区别于概率论的"事件频率"。模糊是**本体论模糊**（vagueness），不是认知不确定（uncertainty）。

#### 关键公式

- **隶属函数**：$\mu_A: X \to [0,1]$，常用三角形、梯形、高斯型。
- **Zadeh 算子**：
  - 与（AND，t-norm min）：$\mu_{A \cap B}(x) = \min(\mu_A(x), \mu_B(x))$
  - 或（OR，t-conorm max）：$\mu_{A \cup B}(x) = \max(\mu_A(x), \mu_B(x))$
  - 非：$\mu_{\neg A}(x) = 1 - \mu_A(x)$
- **Mamdani 推理**（最常用 FIS）：规则 $R_k$: IF $x$ is $A_k$ AND $y$ is $B_k$ THEN $z$ is $C_k$，对每条规则计算激活度 $w_k = \min(\mu_{A_k}(x_0), \mu_{B_k}(y_0))$，输出截顶 $C_k' = w_k \wedge C_k$，最后聚合 + 重心法去模糊：

  $$
  z^* = \frac{\int z \cdot \mu_{\bigcup_k C_k'}(z)\, dz}{\int \mu_{\bigcup_k C_k'}(z)\, dz}
  $$

#### 与可信度的关系

模糊逻辑适合把"日志严重程度""异常次数""相似度"等**连续模糊概念**映射到 $[0,1]$ 可信度，作为 D-S/主观逻辑 mass 函数的**前端归一化器**。不适合独立承担多源融合（缺乏冲突处理）。

### 2.4 贝叶斯网络（Bayesian Network）

- **奠基文献**：
  - Pearl, J. (1988). *Probabilistic Reasoning in Intelligent Systems*. Morgan Kaufmann.
  - Pearl, J. & Russell, S. (2000). *Bayesian Networks*. UCLA Technical Report R-277.
- **核心思想**：DAG 节点为随机变量，有向边为条件依赖，联合分布按局部条件概率因式分解。
- **公式**（链式分解）：

  $$
  P(x_1, \dots, x_n) = \prod_{i=1}^{n} P(x_i \mid \operatorname{pa}_i)
  $$

  推理即给定证据集 $E$ 求后验 $P(Q \mid E) = \frac{P(Q, E)}{P(E)}$，常用变量消除、信念传播、MCMC。

- **优势**：严格概率公理、支持任意方向推理（预测/诊断/解释消去）。
- **局限**：需先验 CPT，结构学习 NP-hard，大规模实时推理慢。

### 2.5 四种理论横向对比

| 维度 | D-S 证据理论 | 主观逻辑 | 模糊逻辑 | 贝叶斯网络 |
|---|---|---|---|---|
| 表征对象 | 多源证据的 belief/plausibility | (b,d,u,a) opinion | 隶属度 | 条件概率分布 |
| 是否需先验 | 否 | 部分（base rate） | 否 | 是 |
| 处理"无知" | 显式（mass on $\Theta$） | 显式（u） | 隐式 | 隐式（先验均匀） |
| 处理证据冲突 | 显式（K 冲突系数） | 通过 u 体现 | 无 | 假设一致，可能放大错误 |
| 计算复杂度 | $O(2^n)$ | $O(n)$ | $O(n)$ | NP-hard 推理 |
| 多级信任传播 | 需扩展 | 原生 $\otimes$ | 不支持 | 需建模为节点 |
| JS/TS 库 | 无成熟包（自行实现） | 无（自行实现，~200 行 TS） | `fuzzyis` | `bayesjs`, `jsbayes`, `tsbbn` |
| 与本项目匹配度 | ★★★★★ | ★★★★ | ★★★ | ★★★ |

---

## 3. LLM 输出可信度评估

### 3.1 logprob / token probability

- **思路**：对生成的 token 序列 $y = (y_1, \dots, y_T)$，取每 token 对数概率 $\log p(y_t \mid y_{<t}, x)$。
- **常用聚合**：
  - 平均对数概率：$\bar{\ell} = \frac{1}{T}\sum_t \log p(y_t \mid \cdots)$
  - 困惑度：$\text{PPL} = \exp\!\bigl(-\tfrac{1}{T}\sum_t \log p(y_t)\bigr)$
  - 最小 token 概率：$\ell_{\min} = \min_t \log p(y_t)$（瓶颈 token 主导）
- **局限**：现代 LLM 普遍**过度自信**（Guo et al. 2017, *On Calibration of Modern Neural Networks*；Kadavath et al. 2022 *Language Models (Mostly) Know What They Know*），logprob 与正确性弱相关。
- **可用性**：OpenAI / Anthropic 部分模型支持 `logprobs` 返回；本项目若用闭源 API 需确认模型支持。
- **相关论文**：
  - *SelfCertainty*（arXiv:2502.18581, 2025）：定义 $\mathrm{SC}(p) = \mathrm{KL}(U \| p)$，比平均 logprob 在 Best-of-N 选择上更鲁棒。
  - *Entropy Trajectory Shape*（arXiv:2603.18940, 2026）：发现 token logprob 的 ECE 随 CoT 步数从 0.186 → 0.312 恶化。

### 3.2 自一致性采样投票（Self-Consistency）

- **论文**：Wang et al., *Self-Consistency Improves Chain of Thought Reasoning in Language Models*, ICLR 2023, arXiv:2203.11171
- **思路**：温度采样 $N$ 条推理路径 $\{y^{(i)}\}_{i=1}^{N}$，对最终答案做多数投票：
  $$
  \hat{a} = \arg\max_a \sum_{i=1}^{N} \mathbb{1}[a^{(i)} = a]
  $$
- **可信度**：投票占比即朴素可信度：
  $$
  c_{\text{SC}} = \frac{\max_a \sum_i \mathbb{1}[a^{(i)} = a]}{N}
  $$
- **改进：Confidence-Improves-SC (CISC)**（arXiv:2502.06233, 2025）：用每条样本的归一化置信度 $\tilde{c}_i$ 加权投票：
  $$
  \hat{a}_{\text{CISC}} = \arg\max_a \sum_{i=1}^{N} \mathbb{1}[a^{(i)} = a] \cdot \tilde{c}_i, \quad \tilde{c}_i = \frac{\exp(c_i / T)}{\sum_j \exp(c_j / T)}
  $$
- **改进：CGES**（arXiv:2511.02603, 2025）：贝叶斯框架，token prob/reward 形成候选答案后验，自适应停止采样，平均减少 69.4% 调用次数。
- **代价**：需 $N \ge 5$ 次推理，对运维实时性场景需权衡。

### 3.3 置信度校准（Platt / Temperature Scaling）

- **奠基**：
  - Platt, J. (1999). *Probabilistic Outputs for Support Vector Machines*.
  - Guo et al. (2017). *On Calibration of Modern Neural Networks*. ICML.
- **Temperature Scaling**（最轻量）：在 logits $z$ 上引入标量 $T$：
  $$
  \hat{p}_i = \frac{\exp(z_i / T)}{\sum_j \exp(z_j / T)}
  $$
  在验证集上最小化 NLL 学习 $T$。
- **Platt Scaling**：用 logistic 拟合 $p(y=1 \mid f) = \frac{1}{1 + \exp(Af + B)}$。
- **评估指标**：
  - **ECE**（Expected Calibration Error）：
    $$
    \mathrm{ECE} = \sum_{m=1}^{M} \frac{|B_m|}{N} \bigl| \mathrm{acc}(B_m) - \mathrm{conf}(B_m) \bigr|
    $$
  - **Brier Score**：$\mathrm{BS} = \frac{1}{N}\sum_i (f_i - o_i)^2$
- **最新方法**：
  - *Unsupervised Confidence Calibration for Reasoning LLMs from a Single Generation*（arXiv:2604.19444, 2026）：用 self-consistency 离线采样作为弱标签，蒸馏为单次推理的轻量预测头，无需标注数据。
  - *MetaFaith*（EMNLP 2025）：基于元认知提示的语言层校准，提升 61% faithfulness。

### 3.4 RAG 检索分数 → 可信度映射

RAG 系统的可信度信号有三层：

1. **检索层分数**：cosine 相似度、BM25、混合分数。但**检索分数高 ≠ 答案可信**（可能检索正确但 LLM 误读）。
2. **生成层 token logprob**：见 [§3.1]。
3. **证据一致性层**（最关键）：
   - **Faithfulness**（RAGAS、RAGChecker、RAGVUE）：将答案拆分为 claim，逐 claim 判断是否被检索上下文支持。
   - **RAGChecker**（arXiv:2408.08067, 2024）：细粒度 claim-level 评估，区分 retriever 错 vs generator 错。
   - **FIDES**（arXiv:2606.05644, 2026）：三信号融合（opposition 输出层张力 + shift 隐藏态漂移 + noise 内部预测不稳定性），权重通过无标签校准池估计 $\tilde{w}_i = (1/\hat{\sigma}_i) / \sum_j (1/\hat{\sigma}_j)$。
- **Trustworthy RAG 框架**：Wang et al., *Towards Trustworthy RAG: A Survey*（arXiv:2409.11598, 2024），提出六维可信度模型：

  $$
  \text{Trustworthiness}(\text{RAG}) = \bigcap_{d \in \mathcal{D}} \operatorname{Satisfy}(d), \quad \mathcal{D} = \{\text{Accuracy, Calibration, Consistency, Fairness, Privacy, Safety}\}
  $$

### 3.5 Chain-of-Thought 可信度传播

- **核心问题**：CoT 步级错误会累积，但单步 token logprob 与正确性弱相关（甚至随步数变深 ECE 上升）。
- **方法 1：步级置信度预测器**
  - *Deep Hidden Cognition*（AAAI 2026, Chen et al.）：训练 confidence predictor 量化模型内部"truthfulness 认知"，引导 beam search 选最可靠路径，超过 Self-Consistency 与 PRM。
- **方法 2：熵轨迹形状**
  - *Entropy Trajectory Shape*（arXiv:2603.18940, 2026）：定义"熵轨迹单调性"——若每步答案分布熵都下降，则链条更可靠。GSM8K 上单调链准确率 68.8% vs 非单调 46.8%（OR=2.50）。
- **方法 3：CoT-UQ**
  - arXiv:2502.17214, 2025：每步抽取关键词，按关键词重要性加权聚合不确定性。
- **方法 4：Confidence-Aware Self-Consistency**
  - arXiv:2603.08999, 2026：分析单条 CoT 轨迹的句子级数值/语言特征，自适应决定是否需要多路径采样，节省 80% token。

### 3.6 推荐的 LLM 可信度组合信号

针对本项目（运维决策，需实时性 + 可解释）：

$$
c_{\text{LLM}} = w_1 \cdot c_{\text{logprob}}^{\text{cal}} + w_2 \cdot c_{\text{SC}} + w_3 \cdot c_{\text{faith}} + w_4 \cdot c_{\text{CoT-shape}}
$$

- $c_{\text{logprob}}^{\text{cal}}$：经温度缩放校准的 token 概率聚合（**默认 $w_1=0.3$**）
- $c_{\text{SC}}$：3-5 路径 self-consistency 投票占比（**$w_2=0.4$**，最强单信号）
- $c_{\text{faith}}$：RAG claim-level faithfulness 比例（**$w_3=0.2$**）
- $c_{\text{CoT-shape}}$：熵轨迹单调性二值/连续化（**$w_4=0.1$**，低成本附加）

权重为初始值，应在项目验证集上 ECE 最小化微调。

---

## 4. 运维决策可信度具体方案

### 4.1 多源证据定义

| 源 ID | 名称 | 输出形式 | 可信度先验 |
|---|---|---|---|
| $S_1$ | 系统日志 | 异常分数 $s_1 \in [0,1]$ | 高（客观） |
| $S_2$ | 知识库（RAG） | 检索 + faithfulness | 中（KB 时效性） |
| $S_3$ | 模型参数 / 监控阈值 | 命中布尔/数值 | 高（人工设定） |
| $S_4$ | 人工决策 | 显式投票/标注 | 由操作员历史准确率 $r_4$ 决定 |
| $S_5$ | 历史对话 | 相似案例匹配分 | 中（旧案例可能过时） |
| $S_6$ | 最佳实践库 | 规则匹配度 | 高（但场景适配性低） |

### 4.2 加权融合公式

最朴素方案，将每源归一化到 $[0,1]$ 可信度 $c_i$ 与决策方向 $v_i \in \{-1, +1\}$（否决/支持）：

$$
c_{\text{weighted}} = \frac{\sum_{i=1}^{6} w_i \cdot c_i \cdot v_i}{\sum_{i=1}^{6} w_i \cdot c_i}
$$

- 权重 $w_i$ 由源可靠性 $r_i$ 与时效性 $\tau_i$ 联合决定：$w_i = r_i \cdot e^{-\lambda \Delta t_i}$
- 决策阈值：$c_{\text{weighted}} > \theta_{\text{accept}}$ → 自动执行；$< \theta_{\text{reject}}$ → 自动拒绝；中间区间 → 转人工。

**优点**：实现 30 行 TS 即可。
**缺点**：无法表达"我不知道"，无法处理证据强冲突。

### 4.3 D-S 证据融合公式

把每源 $S_i$ 转换为识别框架 $\Theta = \{\text{故障}, \text{正常}\}$ 上的 BPA：

$$
m_i(\{\text{故障}\}) = c_i \cdot v_i^{+}, \quad m_i(\{\text{正常}\}) = c_i \cdot v_i^{-}, \quad m_i(\Theta) = 1 - c_i
$$

其中 $v_i^{+}$ 为支持故障的归一化权重，$v_i^{-}$ 为支持正常的归一化权重，$1 - c_i$ 即"无知"质量。

按 Dempster 规则逐步融合 $m_{1 \oplus 2 \oplus \dots \oplus 6}$，得到联合 mass：

$$
m_{\oplus}(A) = \frac{\sum_{\bigcap_i B_i = A} \prod_i m_i(B_i)}{1 - K}, \quad K = \sum_{\bigcap_i B_i = \emptyset} \prod_i m_i(B_i)
$$

最终可信度区间 $[\operatorname{Bel}(\{\text{故障}\}), \operatorname{Pl}(\{\text{故障}\})]$：

- $\operatorname{Bel}$ 高 → 强证据支持故障，可自动处置
- $\operatorname{Pl} - \operatorname{Bel}$ 大 → 不确定性高，应转人工
- $K > 0.5$ → 证据冲突大，启用 **PCR5** 替代：

$$
m_{\text{PCR5}}(A) = m_{12}(A) + \sum_{B \cap A = \emptyset} \left[ \frac{m_1(A)^2 \cdot m_2(B)}{m_1(A) + m_2(B)} + \frac{m_2(A)^2 \cdot m_1(B)}{m_2(A) + m_1(B)} \right]
$$

### 4.4 贝叶斯融合公式

将"故障" $F$ 作为根节点，各源观测 $o_i \in \{0,1\}$ 为子节点，构建朴素贝叶斯：

$$
P(F \mid o_1, \dots, o_6) = \frac{P(F) \prod_{i=1}^{6} P(o_i \mid F)}{\sum_{F' \in \{0,1\}} P(F') \prod_i P(o_i \mid F')}
$$

- $P(F)$：历史故障先验（如日均故障率）
- $P(o_i \mid F)$：源 $i$ 在故障时的命中率（sensitivity）
- $P(o_i \mid \neg F)$：源 $i$ 在正常时的误报率（false positive rate）

**优点**：严格概率公理，可融入先验。
**缺点**：需要可靠的 sensitivity / FPR 标定，运维场景冷启动困难；无法表达"无知"。

### 4.5 推荐混合方案（加权 + D-S + 风险阈值）

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: 源归一化（模糊隶属度 → [0,1]）                 │
│  - 日志异常分 → μ(异常)                                  │
│  - RAG faithfulness → c_faith                            │
│  - 历史相似度 → c_hist                                   │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  Layer 2: LLM 侧可信度（§3.6 组合信号）                  │
│  c_LLM = 0.3·logprob_cal + 0.4·SC + 0.2·faith + 0.1·CoT │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  Layer 3: D-S 融合（六源 + LLM 共七源 BPA）              │
│  m_total = m_1 ⊕ m_2 ⊕ ... ⊕ m_6 ⊕ m_LLM              │
│  if K > 0.5: 切换到 PCR5                                 │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  Layer 4: 风险决策                                       │
│  - Bel(故障) > 0.8 ∧ Pl - Bel < 0.15 → 自动处置         │
│  - Bel(故障) < 0.2 ∧ Pl - Bel < 0.15 → 自动放行         │
│  - 否则 → 转人工，附带证据链                             │
└─────────────────────────────────────────────────────────┘
```

### 4.6 可视化方案

#### 4.6.1 证据链图（Evidence Chain）

- **形态**：左→右 DAG，左侧为证据源节点，中间为融合算子节点，右侧为决策节点。
- **每节点携带**：源名、原始值、归一化 mass、可信度色块。
- **实现技术**：React + **React Flow**（推荐，MIT，22k+ stars）或 **D3.js** + **dagre** 自动布局。Mermaid 备选（写法简单但交互弱）。
- **示例数据流**：

  ```
  [日志] ─┐
  [RAG]  ─┤
  [参数] ─┼──→ [D-S ⊕] ──→ [Bel/Pl] ──→ [决策: 转人工]
  [人工] ─┤      ↓ K=0.42
  [历史] ─┤   [切换PCR5]
  [实践] ─┘
  ```

#### 4.6.2 置信度仪表盘（Confidence Dashboard）

- **核心组件**：
  1. **Confidence Meter**：0–100% 半圆仪表，颜色 Red < 60% / Amber 60–80% / Green > 80%
  2. **Belief/Plausibility 区间条**：水平条形，左端 Bel、右端 Pl，区间宽度直观反映不确定性
  3. **冲突系数 K 指示器**：单独小仪表，K > 0.5 时红色闪烁
  4. **历史趋势 Sparkline**：过去 N 次决策可信度走势
- **实现库**：`recharts`（React 友好）或 `@nivo/line` + `@nivo/gauges`；备选 `apexcharts`。

#### 4.6.3 风险等级色带（Risk Level Color Band）

- **三色分级**（参照 CVSS 行业标准 + Procurize/Slim.io 实践）：
  - 🟢 绿（0.0–0.33 / Bel < 0.2）：低风险，自动放行
  - 🟡 黄（0.34–0.66 / Bel ∈ [0.2, 0.8]）：中风险，转人工
  - 🔴 红（0.67–1.0 / Bel > 0.8）：高风险，立即处置或报警
- **扩展为四色**（增加橙色）：
  - 0–30 绿 / 31–60 黄 / 61–80 橙 / 81–100 红
- **交互**：点击色带某段展开对应区间的历史案例与处置建议。
- **实现**：CSS 渐变 + React 状态机即可，无需额外库。

### 4.7 相关开源实现与论文参考

- **sift-kernel**（Devpost hackathon）：TypeScript MCP server，用 Dempster-Shafer + PCR5 做数字取证证据融合，含 hash-chained evidence ledger、SVG 熵曲线、置信度评分。**最贴近本项目技术栈**的参考。
  - 关键代码模式：`m12(A) = sum(m1(B)*m2(C) for B∩C=A) / (1 - K)`，K > 0.3 切 PCR5。
- **@unrdf/decision-fabric**（npm）：意图→决策转换引擎，含 Socratic AI 假设抽取与 Pareto 分析，可借鉴"证据→决策→置信度"的 API 设计。
- **RAGChecker / RAGVUE / RAGAS**：RAG 评估框架，可借鉴 claim-level faithfulness 实现。
- **SelfCheckGPT**（Manakul et al. 2023）：黑盒幻觉检测，多采样一致性。

---

## 5. arXiv 近 2 年论文检索

### 5.1 Trustworthy LLM

| 论文 | 作者 | 年份 | arXiv ID | 核心贡献 |
|---|---|---|---|---|
| *Towards Trustworthy RAG: A Survey* | Wang, Luo, Wei et al. | 2024 | 2409.11598 | 提出六维 RAG 可信度框架（Accuracy/Calibration/Consistency/Fairness/Privacy/Safety），综述 60 篇文献 |
| *Trusted Uncertainty in LLMs: UniCR* | Oehri, Conti et al. | 2025 | 2509.01455 | 统一框架融合 sequence likelihood / self-consistency dispersion / retrieval 兼容性 / verifier feedback，温度缩放校准头 + conformal risk control，分布无关保证 |
| *Confidence-Based Response Abstinence* | Huang, Datla et al. (Capital One) | 2025 | 2510.13750 | RAG 系统中用 FFN 第 16 层激活做置信度预测（避免 logit/softmax 信息损失），金融客服场景落地 |
| *MetaFaith: Faithful NL Uncertainty Expression* | Liu, Yona et al. (Yale/Google) | 2025 | EMNLP 2025 | 首个系统研究 LLM 语言层 faithful calibration，提出元认知提示法，faithfulness 提升 61%，人类胜率 83% |
| *Prompt4Trust* | Kriz, Janes et al. (McGill) | 2025 | 2507.09279 | RL 框架做 prompt 增强 + 临床对齐的 MLLM 置信度校准，PMC-VQA SOTA，小模型训练可零样本迁移到大模型 |
| *A Survey of AIOps in the Era of LLMs* | (多作者) | 2025 | 2507.12472 | 系统综述 2020.01–2024.12 共 183 篇 AIOps+LLM 论文，覆盖数据/任务/方法/评估 |

### 5.2 Confidence Calibration

| 论文 | 作者 | 年份 | arXiv ID | 核心贡献 |
|---|---|---|---|---|
| *On Calibration of Modern Neural Networks* | Guo, Pleiss, Sun, Weinberger | 2017 | 1706.04599 | 奠基性工作，提出 temperature scaling，揭示现代 DNN 过自信 |
| *Language Models (Mostly) Know What They Know* | Kadavath et al. (Anthropic) | 2022 | 2207.05221 | 首次系统研究 LLM 自评置信度，P(True) 方法 |
| *Self-Consistency Improves CoT* | Wang et al. | 2023 | 2203.11171 | 多采样投票奠基，ICLR 2023 |
| *Confidence Improves Self-Consistency (CISC)* | — | 2025 | 2502.06233 | 置信度加权 SC 投票 |
| *Scalable Best-of-N via Self-Certainty* | — | 2025 | 2502.18581 | KL 散度定义 self-certainty SC(p)=KL(U‖p)，优于平均 logprob |
| *CGES: Confidence-Guided Early Stopping* | Aghazadeh et al. | 2025 | 2511.02603 | 贝叶斯后验 + 自适应停止，平均减少 69.4% 调用 |
| *Unsupervised Confidence Calibration for Reasoning LLMs from a Single Generation* | Zollo, Wang, Zemel (Columbia) | 2026 | 2604.19444 | 离线 self-consistency 弱标签 + 单次推理蒸馏，5 任务 9 模型验证 |
| *When Can We Trust LLM Graders?* | Vasquez Ferrer et al. (UCF) | 2026 | 2603.29559 | 三种置信度估计方法（自报/SC/token prob）跨 7 个 4B–120B 模型对比，自报置信度 ECE 最佳 0.166 |
| *Confidence as Control: A Survey* | (Anonymous ACL) | 2025 | OpenReview | 把置信度作为系统控制信号的统一综述（训练/推理/部署） |

### 5.3 Evidence-based Decision / 多源证据融合

| 论文 | 作者 | 年份 | arXiv ID / 出处 | 核心贡献 |
|---|---|---|---|---|
| *Dempster-Shafer Evidence Theory and Study of Some Key Problems* | Lu, He | 2017 | J. Electronic Science & Technology | D-S 中文综述，覆盖解释模型/组合算法/冲突改进 |
| *An Improved Multi-Source Data Fusion Method Based on Belief Entropy and Divergence Measure* | Wang, Xiao | 2019 | Entropy 21(6):611 | Belief Jensen-Shannon 散度 + 信念熵加权，故障诊断应用 |
| *Multimodal Learning with Uncertainty Quantification based on Discounted Belief Fusion* | Bezirganyan, Sellami et al. | 2024 | 2412.18024 | 主观逻辑 Discounted Belief Fusion + 冲突折扣，多模态场景 |
| *Subjective Logic Encodings* | Vasilakes, Zerva, Ananiadou | 2025 | 2502.12225 | 主观逻辑编码标注不确定性，Dirichlet 分布目标，数据透视主义 |
| *FIDES: Faithful Inference via Deep Evidence Signals for RAG* | — | 2026 | 2606.05644 | 三层信号融合（opposition + shift + noise），权重通过无标签校准池估计 |
| *Impact of Evidence Theory Uncertainty on Training Object Detection* | — | 2024 | 2412.17405 | D-S 在目标检测训练中的应用，含 BPA/Bel/Pl/Dempster 规则完整公式 |

### 5.4 AIOps / 日志异常检测可信决策

| 论文 | 作者 | 年份 | arXiv ID / 出处 | 核心贡献 |
|---|---|---|---|---|
| *Is Your Anomaly Detector Ready for Change?* | Poenaru-Olaru et al. (TU Delft) | 2024 | CAIN 2024, 2311.10421 | AIOps 异常检测概念漂移与模型维护，盲训 vs 知情重训 |
| *AI-Augmented Anomaly Detection via Generative Distribution Modeling and UQ* | Chen, F. | 2024 | TCSM Vol.4 No.11 | GAN + 不确定性量化五阶段框架（编码/潜空间/重构/判别/置信度调节） |
| *SaRLog: Semantic-Aware Robust Log Anomaly Detection via BERT-Augmented Contrastive Learning* | Jilcha, Kim, Kwak | 2024 | IEEE IoT J. 11(13) | BERT + Siamese 对比学习，BGL/Thunderbird F1 达 0.988/0.999 |
| *Towards Trustworthy Cybersecurity Operations using Bayesian Deep Learning* | Yang, Qiao, Lee | 2024 | Computers & Security 144:103909 | Bayesian Autoencoder 联合 aleatoric + epistemic 不确定性，UNSW-NB15/CIC-IDS-2017 验证 |

---

## 6. Electron + React + TypeScript 实现可行性

### 6.1 JS/TS 库评估

| 算法领域 | 可用库 | 状态 | 推荐度 |
|---|---|---|---|
| **D-S 证据理论** | 无成熟 npm 包 | 需自行实现 | ★ 自行实现 ~150 行 TS |
| **主观逻辑** | 无 | 需自行实现 | ★ 自行实现 ~200 行 TS |
| **模糊逻辑** | `fuzzyis` (9 年未更新, 5 周下载) | 可用但老旧 | ★★ 仅做隶属度归一化时够用 |
| **贝叶斯网络** | `bayesjs` (5 年未更新)、`jsbayes`、`tsbbn` (TS)、`bayesian-network` | 多个可选 | ★★★ 推荐用 `bayesjs` 或 `tsbbn` |
| **SHAP / LIME** | 无 | 仅 Python | ★ 需 Python sidecar 或仅用于本地小模型 |
| **Attention Rollout** | 无 | 自行实现 ~50 行 | ★★ 仅本地 Transformer |
| **校准（Temperature/Platt）** | 无 | 自行实现 ~30 行 | ★★★ 极简 |
| **置信度仪表盘可视化** | `recharts`, `@nivo/*`, `apexcharts` | 活跃 | ★★★★★ React 生态完美支持 |
| **证据链图可视化** | `reactflow` (React Flow) | 活跃 22k★ | ★★★★★ |
| **图布局算法** | `dagre`, `elkjs` | 活跃 | ★★★★★ |
| **状态管理** | `zustand` / `jotai` | 活跃 | ★★★★★ |
| **Markdown 渲染（证据展开）** | `react-markdown` + `remark-math` | 活跃 | ★★★★★ |

### 6.2 实现路径建议

1. **核心融合层**：纯 TS 自行实现 D-S（含 PCR5 fallback）+ 主观逻辑累积融合算子。代码量小、零外部依赖、Electron 主进程跑即可。
2. **LLM 可信度采集**：在调用 OpenAI/Anthropic/本地模型 API 时启用 `logprobs` 选项，记录到证据收集器；若用本地模型（如 ONNX Runtime Web、llama.cpp WASM）可直接读 logits。
3. **校准层**：实现 temperature scaling，在验证集（人工标注 50–200 条历史决策）上离线学习 $T$。
4. **可视化层**：
   - 证据链图用 React Flow + dagre 自动布局
   - 仪表盘用 recharts
   - 风险色带用纯 CSS + Tailwind 渐变
5. **可选 Python sidecar**：若需 SHAP 解释本地小模型，可用 `child_process` 调 Python 脚本（`shap` 包），通过 stdio 传 JSON。Electron 应用打包时把 Python runtime 一起打进去（pyinstaller）。

### 6.3 性能预算

- D-S 融合（六源 BPA + LLM 共 7 源，$\Theta$ 二元）：纯 TS < 1ms
- Self-consistency（3 路 GPT-4 调用）：3–9s（瓶颈在网络，不在融合层）
- 证据链图渲染（30 节点）：< 50ms
- 仪表盘实时刷新：60fps 无压力

---

## 7. 重点推荐算法（针对本项目）

### 7.1 主推：D-S 证据理论 + 加权混合方案

**理由**：

1. **领域匹配**：运维场景天然多源异构（日志/KB/参数/人工/历史/实践），D-S 的 BPA 可以把每源 $[0,1]$ 可信度直接映射为 mass，$\Theta$ 上的 mass 即"无知"，完美契合运维"我不知道"的常态。
2. **冲突处理**：运维场景经常出现"日志说正常但人工经验说异常"的冲突，D-S 的 $K$ 系数 + PCR5 fallback 提供数学上严格的冲突处理。
3. **工程成本**：纯 TS ~150 行可实现核心融合，无外部依赖，Electron 主进程跑无压力。
4. **可视化匹配**：Bel/Pl 区间天然映射到"置信度仪表盘"，K 系数天然映射到"冲突指示器"，多源 BPA 天然映射到"证据链图"。
5. **学术背书**：D-S 在故障诊断、目标识别、医疗诊断领域有大量成功案例（见 §5.3）。

### 7.2 次推：主观逻辑（当需要信任链传播时）

**何时切换到主观逻辑**：

- 当"人工决策源"需要按操作员历史准确率动态折扣时
- 当"历史对话源"需要按时间衰减且与操作员可信度耦合时
- 当需要"多级信任链"（如：操作员 A 信任专家 B，B 信任文档 C）时

**实现成本**：~200 行 TS，比 D-S 略多。建议作为 D-S 的可选升级模块，而非替代。

### 7.3 不推荐独立使用

- **SHAP/LIME**：闭源 LLM 不可用，仅作为本地小模型的辅助解释。
- **模糊逻辑**：作为前端归一化器（隶属度函数）使用，不作为主融合算法。
- **贝叶斯网络**：需要可靠的 CPT 标定，运维场景冷启动困难；可在积累足够历史数据后作为 D-S 的对照验证。

---

## 8. 参考来源

### 论文与学术资源

- Lundberg & Lee, *A Unified Approach to Interpreting Model Predictions*, NeurIPS 2017, arXiv:1705.07874
- Ribeiro, Singh, Guestrin, *Why Should I Trust You?*, KDD 2016, arXiv:1602.04938
- Abnar & Zuidema, *Quantifying Attention Flow in Transformers*, ACL 2020
- Shafer, G. *A Mathematical Theory of Evidence*, Princeton 1976
- Jøsang, A. *Subjective Logic*, Springer 2016
- Zadeh, L.A. *Fuzzy Sets*, Information and Control 1965
- Pearl, J. *Probabilistic Reasoning in Intelligent Systems*, 1988
- Wang et al. *Self-Consistency Improves CoT*, ICLR 2023, arXiv:2203.11171
- Guo et al. *On Calibration of Modern Neural Networks*, ICML 2017, arXiv:1706.04599
- Wang et al. *Towards Trustworthy RAG: A Survey*, 2024, arXiv:2409.11598
- Oehri et al. *Trusted Uncertainty in LLMs (UniCR)*, 2025, arXiv:2509.01455
- Huang et al. *Confidence-Based Response Abstinence*, 2025, arXiv:2510.13750
- Liu et al. *MetaFaith*, EMNLP 2025
- Kriz et al. *Prompt4Trust*, 2025, arXiv:2507.09279
- Zollo et al. *Unsupervised Confidence Calibration for Reasoning LLMs*, 2026, arXiv:2604.19444
- Zhao *Entropy Trajectory Shape Predicts LLM Reasoning Reliability*, 2026, arXiv:2603.18940
- Zhang & Zhang *CoT-UQ*, 2025, arXiv:2502.17214
- Xiong et al. *Learning When to Sample*, 2026, arXiv:2603.08999
- Chen et al. *Deep Hidden Cognition Facilitates Reliable CoT*, AAAI 2026
- Ru et al. *RagChecker*, 2024, arXiv:2408.08067
- *FIDES: Faithful Inference via Deep Evidence Signals*, 2026, arXiv:2606.05644
- Aghazadeh et al. *CGES*, 2025, arXiv:2511.02603
- *Confidence Improves Self-Consistency (CISC)*, 2025, arXiv:2502.06233
- *Scalable Best-of-N via Self-Certainty*, 2025, arXiv:2502.18581
- Vasquez Ferrer et al. *When Can We Trust LLM Graders?*, 2026, arXiv:2603.29559
- Bezirganyan et al. *Multimodal Learning with UQ based on Discounted Belief Fusion*, 2024, arXiv:2412.18024
- Vasilakes et al. *Subjective Logic Encodings*, 2025, arXiv:2502.12225
- Wang & Xiao *Improved Multi-Source Data Fusion*, Entropy 2019, 21(6):611
- Lu & He *Dempster-Shafer Evidence Theory and Study of Some Key Problems*, JEST 2017
- *Impact of Evidence Theory Uncertainty on Training Object Detection*, 2024, arXiv:2412.17405
- *A Survey of AIOps in the Era of LLMs*, 2025, arXiv:2507.12472
- Poenaru-Olaru et al. *Is Your Anomaly Detector Ready for Change?*, CAIN 2024, arXiv:2311.10421
- Yang, Qiao, Lee *Towards Trustworthy Cybersecurity Operations using BDL*, Computers & Security 2024, 144:103909
- Jilcha et al. *SaRLog*, IEEE IoT J. 2024, 11(13)

### 开源实现

- Python `shap`: https://github.com/shap/shap
- Python `lime`: https://github.com/marcotcr/lime
- Python `pgmpy`: https://github.com/pgmpy/pgmpy
- npm `fuzzyis`: https://www.npmjs.com/package/fuzzyis
- npm `bayesjs`: https://www.npmjs.com/package/bayesjs
- npm `jsbayes`: https://www.npmjs.com/package/jsbayes
- npm `tsbbn` (TypeScript BBN): https://www.npmjs.com/package/tsbbn
- npm `bayesian-network`: https://www.npmjs.com/package/bayesian-network
- npm `@unrdf/decision-fabric`: https://www.npmjs.com/package/@unrdf/decision-fabric
- npm `reactflow` (React Flow): https://reactflow.dev/
- npm `recharts`: https://recharts.org/
- npm `@nivo/*`: https://nivo.rocks/
- npm `dagre` / `elkjs`: 图布局
- sift-kernel（D-S + PCR5 TypeScript 参考实现）: https://devpost.com/software/sift-kernel
- RAGChecker: https://github.com/amazon-science/RAGChecker
- RAGVUE: https://github.com/KeerthanaMurugaraj/RAGVue
- SelfCheckGPT: https://github.com/potsawee/selfcheckgpt
- Prompt4Trust: https://github.com/xingbpshen/prompt4trust
- CoG-CoT: https://github.com/hfutml/cog-cot
- SLEncodings (Subjective Logic): https://github.com/jvasilakes/SLEncodings

### 综述与工业实践

- Procurize *Explainable AI Confidence Dashboard*: https://www.procurize.ai/blog/explainable-ai-confidence-dashboard-for-secure-questionnaire/
- Slim.io *Data Visualization*: https://docs.slim.io/platform/visualization
- Anthropic *Language Models (Mostly) Know What They Know*, 2022, arXiv:2207.05221

---

**文档版本**：v1.0
**完成日期**：2026-07-17
**下一步规划**：
1. 在项目验证集（50–200 条历史运维决策）上标定各源 $r_i, \tau_i, c_i$ 初始值
2. TS 实现 D-S + PCR5 融合模块（核心 ~150 行）
3. TS 实现 temperature scaling 校准器（~30 行）
4. React Flow 实现证据链图组件
5. recharts 实现置信度仪表盘 + 风险色带
6. 与 LLM API 集成 logprob / self-consistency 采集
7. A/B 对比：纯加权融合 vs D-S 融合 vs 混合方案的 ECE 与人工干预率
