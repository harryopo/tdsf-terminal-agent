# P4 下一命令回放基线（独立 Python 裁判）

> **数据声明：本目录 `cases.json` 为人工合成序列（`synthetic-hand-computable`），不是真实用户数据，也不是真实 SSH/终端会话。**
> 所有 `namespaceId` / `epoch` / `cwdKey` 均为合成 ID（`ns-*` / `ep-*` / `cwd-synth-*`），不含主机名、IP、用户名等隐私。
> 本目录是外部 AI 产出，未经 ROOT 验收。

- 任务：P4（下一命令回放基线）
- 分支：`codex/delegate-p4-20261105`
- 基线：`bb039b4270fc22b5321c4cfa976fcab705c9b335`（固定，不 rebase、不跟随主仓库 HEAD）
- 规范与合同只从主仓库绝对路径只读，见工作树根 `HANDOFF-PATHS.txt`
- 只在本目录写源码、合成夹具、测试与 README；不改生产代码、锁文件、公共 HANDOFF；不 push／merge／切主树
- 独立 Python 标准库实现，不导入生产 TS ranker

## 文件

| 文件 | 作用 |
| --- | --- |
| `baselines.py` | 四个固定基线 `mru` / `mfc` / `decay` / `markov`，事件校验、可学习资格、可用性过滤 |
| `metrics.py` | `score_next`（Hit@1/3/5、RR@5、非空覆盖）与 `aggregate_scores` |
| `replay.py` | 时间滚动回放 `replay(events, queries, kind)`、`replay_all(cases)`、CLI |
| `cases.json` | 14 条人工合成 query 的夹具 + 人工手算 `handExpected` / `handExpectedScores` |
| `test_baselines.py` | 基线、隔离、过滤顺序、手算控制、污染负控制 |
| `test_metrics.py` | 计分口径、精确匹配、空结果分母 |
| `test_replay.py` | 手算期望全量比对、泄漏防护、错误期望负控制、digest 固定 |
| `evidence/` | 本地原始测试输出与回放报告（**不提交**，见 `handoff.md`） |

## 口径（与共享合同 C 节一致）

- 可学习事件：`origin=user` + `complete=true` + `recordable=true` + 完整 `command` + 退出码已知。
  `exitCode=-1` 先归一为 `null`，不当作正常退出；合法非零（如 `grep` 返回 1）照常计入、不惩罚。
- 命令按**精确字符串**去重与计分，不做参数、引号、大小写、空白规范化。
- 频次类基线（`mru`/`mfc`/`decay`）同 `namespace`、可跨 epoch 累计；`markov` 另要求同 epoch 且 `sequence` 相邻。
- `markov` 的转移按**前序命令文本**在该 epoch 内的合格后继计数构建；前序无合格后继、或 `afterEventId` 不可靠（不存在／被过滤／跨 namespace／跨 epoch）时回退 MFC，不猜最近合格项。
- 先按可用性过滤，再截 Top-5；`availability` 缺项按 `unknown` 处理，只有 `available` 可入选；不把历史执行过当作当前可用。
- 同分排序：频次降序 → 最近使用降序 → 命令 Unicode 字典序升序。
- `decay = Σ 2^(-age_days/7)`；`mru` 按最近使用排序（次级同规则）。
- 回放逐 query 切片 `event.tMs < query.tMs`，`predict` 若收到未来事件直接 `ValueError`，`query` 含 `gold` 同样 `ValueError`。

## 运行

在 `experiments/prediction-replay/` 下，使用主仓库 sidecar venv 的 Python（标准库即可，无第三方依赖）：

```powershell
$py = 'D:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/.venv/Scripts/python.exe'

# 全部测试（-v 输出逐项结果）
& $py -m unittest discover -s . -p 'test_*.py' -v

# 四个基线汇总 + digest
& $py replay.py

# 单基线
& $py replay.py --kind markov

# 完整 JSON 报告
& $py replay.py --json
```

## 当前固定结果（14 条合成 query，分母含空结果）

| baseline | Hit@1 | Hit@3 | Hit@5 | RR@5 | nonEmpty |
| --- | --- | --- | --- | --- | --- |
| mru | 0.2857 | 0.6429 | 0.7143 | 0.4702 | 0.9286 |
| mfc | 0.2143 | 0.6429 | 0.7143 | 0.4345 | 0.9286 |
| decay | 0.2143 | 0.6429 | 0.7143 | 0.4345 | 0.9286 |
| markov | 0.3571 | 0.7143 | 0.7143 | 0.5238 | 0.9286 |

- `casesSha256 = e329240a9c9d7ea151dcc681610ceb81f1e19b7210d2a7fee96b6d3c74004d14`
- 两次独立 CLI 运行的报告 `sha256 = D4233C10684A2B7BF8EB4C789E830B0C4BD8B18938ADD2CDB56981D7C081292B`（字节级一致）
- 冷启动单列：`q-cold`（1 条，预测为空，RR=0）

### 手算控制核对（合同 C 节）

同一 namespace/epoch 内 `pwd, ls, pwd, ls`（0/1000/2000/3000ms，seq 1..4，退出码 0），query 在 4000ms、`afterEventId` 指向第 4 条、`gold=pwd`：

- MRU：`ls` 最后使用 3000ms > `pwd` 2000ms → `[ls, pwd]`，RR@5 = 0.5
- MFC：频次 2:2 打平 → 最近使用 `ls` 优先 → `[ls, pwd]`，RR@5 = 0.5
- decay：`ls` 的年龄和更小 → `[ls, pwd]`，RR@5 = 0.5
- Markov：前序命令 `ls` 的合格后继只有 `pwd`（`ev2→ev3`）→ `[pwd, ls]`，RR@5 = 1.0
- 追加 5000ms 的 `uname -a` 不进入该 query 的历史切片，四个基线结果不变。

## 覆盖的合成场景（14 条 query）

| 场景 | query | 验证点 |
| --- | --- | --- |
| 手算控制 | `q-control` | MRU/MFC `[ls,pwd]`，Markov `[pwd,ls]`，RR 0.5 / 1.0 |
| 冷启动 | `q-cold` | 无历史 → 空预测，RR=0，仍计入分母 |
| 两 namespace 同命令 | `q-two-1`、`q-two-2` | 频次不跨 namespace 混合 |
| epoch 重启 | `q-epoch` | 跨 epoch 不建立转移；Markov 在 `ep-epoch-1` 内用前序命令文本 `cd /tmp` 的合格后继 `ls`（不连到 `ep-epoch-2` 的 `make`/`make test`），不是回退 MFC |
| sequence 缺口 | `q-gap-1`、`q-gap-2` | 跳号不建立转移，相邻转移仍生效 |
| 隐私丢弃 | `q-priv` | `recordable=false`/`command=null` 断链，不跨越连接 |
| 合法非零退出 | `q-nz` | `exitCode=1/3` 照常计入 |
| null / -1 退出 | `q-unk` | `-1` 归一为 null，均不可学习 |
| Agent / probe / unknown 来源 | `q-src` | 非 user 来源不计入 |
| 未知可用性 | `q-avail` | `unknown` 与缺项均被排除 |
| 过滤后截 Top-5 | `q-top5-1`、`q-top5-2` | 先过滤可用性再截断；第 6 名被截掉 |

## 已知限制

1. **合成数据**：14 条 query；**事件命名空间 11 个**（`events[].namespaceId` 去重）、**query 命名空间 12 个**（`queries[].namespaceId` 去重，含仅用于冷启动、无任何事件的 `ns-cold`）、其中**冷启动 query 1 个**（`q-cold`）；总时长秒级；绝对指标不代表真实分布，只用于口径回归与基线对比。
2. **decay 在本夹具中与 MFC 同序**：所有事件都在同一秒内，`2^(-age/7)` 的差异小于 1e-7，排序等价于频次。decay 的时间衰减特性由单测 `test_decay_weights_recent_low_frequency_over_old_high_frequency`（30 天前 ×3 vs 最近 ×1）单独覆盖。
3. **只实现合同 C 节四个固定基线**，不包含生产 `rank-v1` 的 cwd 感知加权、上下文特征与候选过滤；`cwdKey` 仅保留字段，不参与排序。
4. **Markov 为命令文本级一阶转移**（不是 token 级），也不做回退平滑之外的插值。
5. 未接生产 DTO 桥接、未在真实终端数据上回放（由 ROOT 负责）。
