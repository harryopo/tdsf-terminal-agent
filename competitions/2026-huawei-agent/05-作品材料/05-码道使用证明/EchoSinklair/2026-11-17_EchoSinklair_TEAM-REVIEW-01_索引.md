# TEAM-REVIEW-01 码道使用索引

| 字段 | 内容 |
|---|---|
| 证据ID / 负责人 / 日期 / 任务 | `TR01-C1` / EchoSinklair / 2026-11-18 / TEAM-REVIEW-01 |
| 所测完整源码SHA / PR | 产品基线 `210c7874951ddd2ca4572401225ed7decc7a5966`；Draft PR [#56](https://github.com/harryopo/tdsf-terminal-agent/pull/56) |
| 实际工具 / 版本 / 环境 | CodeArts；Windows 11；Python 3.12.8；MinGit 便携版；pytest 9.2.0 |
| 场景 / 预期 / 实际结果 | 源码审查、离线测试与 CodeArts 使用截图；预期完成首轮审查与回归补证；实际提交 Draft PR #56，报告 D1-D11、新增 21 项反例（13 xfail） |
| 来源 / 许可 / 隐私检查 | 本轮材料为自有审查输出；已检查不含密钥、密码、个人地址或终端通知 |

| 图片或材料相对链接 | 文件名 | SHA256 | 原图可公开/脱敏副本 | 所属提交/PR |
|---|---|---|---|---|
| [2026-11-18_EchoSinklair_TEAM-REVIEW-01_01_CodeArts审查与PR页面.png](2026-11-18_EchoSinklair_TEAM-REVIEW-01_01_CodeArts审查与PR页面.png) | 2026-11-18_EchoSinklair_TEAM-REVIEW-01_01_CodeArts审查与PR页面.png | `29C8D8D2A27E71D9BAD54F533E38041A2679E83D4B73B59971F324A1D25A5E46` | 可公开（PR 页面/用户名/任务文本，无凭据） | #56 |
| [2026-11-18_EchoSinklair_TEAM-REVIEW-01_02_CodeArts基线确认.png](2026-11-18_EchoSinklair_TEAM-REVIEW-01_02_CodeArts基线确认.png) | 2026-11-18_EchoSinklair_TEAM-REVIEW-01_02_CodeArts基线确认.png | `54DE73D5B130B4DCB64BBD7BE7C1D4D06250F81398665EBED5261B16A446C582` | 可公开（基线/离线测试结果，无凭据） | #56 |
| [2026-11-18_EchoSinklair_TEAM-REVIEW-01_03_CodeArts材料规范任务.png](2026-11-18_EchoSinklair_TEAM-REVIEW-01_03_CodeArts材料规范任务.png) | 2026-11-18_EchoSinklair_TEAM-REVIEW-01_03_CodeArts材料规范任务.png | `806D256F5D8A4A522198ABB43E7C6DB217ADCD92E35B0E0886B88A60A69A0210` | 可公开（公开 GitHub 规范 URL/任务文本） | #56 |
| [2026-11-18_EchoSinklair_TEAM-REVIEW-01_04_CodeArts工作包与工具调用.png](2026-11-18_EchoSinklair_TEAM-REVIEW-01_04_CodeArts工作包与工具调用.png) | 2026-11-18_EchoSinklair_TEAM-REVIEW-01_04_CodeArts工作包与工具调用.png | `FF3543649666D53D6E004F29EE0087D7B10CB5D9CC32180B60C79FF340A70DE8` | 可公开（工作包文本/工具调用记录，无凭据） | #56 |
| 未入库：`D:\图片\4.png` | 未入库 | 未入库 | 含本地路径，未脱敏；原件私发队长 | 不入公开 PR |

## 说明

本轮按队长材料规范归档 `D:\图片` 中 4 张可公开的 CodeArts 过程截图，替换此前浏览器加载中的自动截图。

- `_01`：CodeArts 对话 + PR #56 页面（含公开用户名/任务文本）。
- `_02`：基线确认与 252/186 离线测试结果。
- `_03`：05-作品材料规范 URL 与任务指令。
- `_04`：完整工作包文本与工具调用记录。
- `D:\图片\4.png` 含本地路径 `E:\huawei_cloud_code\Project_1`，按隐私规则不入公开 PR，原件私发队长。
- 以上均为 CodeArts 实际使用过程证明，不是 04 产品功能截图；未连接真实 SSH、未调用模型。
- 按规范“未实测不补造”，没有生成或复用其它图片。

文本证据：

- 报告：`docs/updates/2026-11-17-TEAM-REVIEW-01-Agent审查摘要.md`
- 测试记录：`competitions/2026-huawei-agent/06-验收与演示/01-测试记录/2026-11-17_EchoSinklair_TEAM-REVIEW-01_离线测试.md`
