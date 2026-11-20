# CORR-03 P3：原文捕获专项（来源 / 行为 / 侵入 / 证明矩阵）

日期：2026-11-20 · 授权：ROOT v1.2 §P3 · 状态：**研究完成；zsh 现有实现已满足，Bash 不接线（保留降级）**
约束：未改产品按键语义、未安装 ble.sh/bash-preexec、未覆盖用户 trap、未改用户配置。

## 1. zsh：现有 `preexec` 首参已满足（真实 PTY 实测）

探针：`.ai/test-runs/corr03-20261120-a1/probes/probe-zsh-preexec-source.sh`
环境：WSL Ubuntu-24.04 / zsh 5.9 / 工作树 `zshrc.zsh`（LF 归一）+ 临时 ZDOTDIR；用户 rc 里 `alias ll='ls -alF'`、`setopt HIST_IGNORE_DUPS`。

| 用例 | 上报 | 结论 |
|---|---|---|
| `ll`（alias） | `133;C;ll` + `F;1;1` | **首参是用户原文，不是展开后的 `ls -alF`** → zsh 无 DEFECT-01 |
| `ll` 连续两次 | 两次 `F;1;1` | **不依赖 history** → zsh 无 DEFECT-02 |
| `printf 'a;b'` | `133;C;printf 'a;b'` + `F;1;0` | 引号内运算符保守判复合（只损失纠错，安全） |
| 空回车 | preexec 不触发（输出只有后续 `exit 0` 的标记） | 不产生伪命令 |
| ` ll`（前导空格） | `133;C; ll` + `F;1;1` | 原文保留前导空格；文本完整 |

结论：**DEFECT-01/02 只存在于 Bash 路径**（Bash 用 history 校验）；zsh 的原文来源与一一归属已成立，
不需要第二套 hook，也不在本包改 zsh 来源判定（只做了 P0 的长度/控制字符降级）。

## 2. Bash：`bind -x` 隔离原型（负结论）

探针：`experiments/command-capture/probe-bind-x.sh`（临时 HOME + 一次性 rc + 真实 PTY）
事实：真实 PTY 下终端驱动把 CR 转 NL，readline 实际走 `\C-j` 绑定，而不是 `\C-m`。

| 用例 | 观测 | 判定 |
|---|---|---|
| 只绑 `\C-m` | `PROBE_LINE` 从未出现，命令正常执行 | 捕获不到真实回车 |
| 只绑 `\C-j` | 拦截生效，但**命令不再执行**；`exit` 也无法提交，shell 挂起（探针超时后人工终止） | 彻底改变提交语义 |
| 同时绑 + 函数内重绑 `accept-line` 并注入 `\C-j` | 仍需接管键图/提交路径 | 侵入用户按键语义，不满足门槛 |

其他已核查的 Bash 来源：

| 来源 | 行为 | 是否可用于生产 |
|---|---|---|
| `$BASH_COMMAND`（现状） | 执行片段；alias 已展开、重复命令无 history 条目 | 已用于 633;E，配合 F 降级（保守） |
| `history 1` | 多行/ignorespace/HISTIGNORE/ignoredups 均会失真 | 只作证据，不作原文 |
| `PS0` | 命令执行前展开，但拿到的是已解析命令文本，不是用户原文 | 不可用 |
| 用户已安装的开源集成（ble.sh / bash-preexec） | 需探测用户是否已装；不得自动安装或覆盖 trap | 本轮未接入，保留调研入口 |
| `readline` 的 `READLINE_LINE`（bind -x） | 能拿原文，但必须接管 Enter/C-j 与键图 | **不批准写入产品**（ROOT §P3） |

生产接线门槛核对（Bash）：

| 门槛 | 结果 |
|---|---|
| 来源由现有 shell/宿主提供 | 否（需接管 readline） |
| 不改变提交语义/用户绑定 | 否（C-j 接管后命令不执行） |
| 原文与真实 block 一一归属 | 原型未达到（需自行驱动执行） |
| 同一 block 的 alias/重复可靠识别 | 未成立 |
| 丢包/截断/歧义拒绝 | 现状已保守降级 |
| 旧协议兼容 | 现状保持 |

→ **Bash 不接线**。保留 `valid=0` 保守路径；研究结果与复跑脚本已交。

## 3. 对 DEFECT-01/02 的最终影响

- zsh 用户：alias 与重复命令**本来就能学习/纠错**（本次实测确认）。
- Bash 用户：alias 命令与连续重复命令仍是 `commandComplete=false`（不学习、不弹 127 纠错），
  属于已登记的保守边界；本包不降低证据标准，也不接管用户按键。
- 后续若要覆盖 Bash，需 ROOT 决定是否接受"接管 Enter/C-j"的独立产品变更；本轮只交负结论。

## 4. 复跑

```bash
wsl -d Ubuntu-24.04 -- bash "<repo>/.ai/test-runs/corr03-20261120-a1/probes/probe-zsh-preexec-source.sh"
wsl -d Ubuntu-24.04 -- bash "<repo>/.local/worktrees/offline-correction-p1-20261119/experiments/command-capture/probe-bind-x.sh"
```

## 5. 未验证 / 风险

- 未覆盖 zsh 的 `preexec` 在 vi 模式、多行编辑、Tab 补全后的首参细节（只覆盖常用路径）。
- 未在 macOS/Linux 本地（非 WSL）复跑；与 WSL 行为差异未测。
- `bind -x` 原型在"只绑 C-j"用例中会使 shell 无法提交，属预期负结论；脚本已注明，勿在生产复跑。
