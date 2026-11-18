# TEAM-REVIEW-01 离线演示步骤

| 字段 | 内容 |
|---|---|
| 负责人 | EchoSinklair |
| 日期 | 2026-11-18 |
| 类型 | 离线测试演示（非原生桌面/非真实 SSH） |
| 产品基线 | `210c7874951ddd2ca4572401225ed7decc7a5966` |
| 共享分支 HEAD | `81e7793f8471a5d843a198bdda2cc1572782b7af` |

## 演示目标

展示首轮审查的离线闭环：既有测试 + 新增反例 + 正向控制，明确 RED 与未测边界。

## 步骤

1. **环境说明**：Windows 11；Python 3.12.8；pytest 9.2.0（临时目录）；不联网、不连真实 SSH、不调用模型。
2. **运行**：在 `src-tauri/sidecar` 下执行本地 runner（`sys.path` 指向临时 pylibs 与 sidecar）。
3. **预期输出**：`108 passed, 13 xfailed`，`exit 0`；文件级收集 121 项。
4. **解释 RED**：
   - D1：5 项目录参数级写操作仍判 L0；
   - D6：2 项短选项密码未在 agent_log 脱敏；
   - D7：1 项审计 reason 副本未脱敏；
   - D9：5 项候选凭据路径未入名单。
   - `xfail(strict=True)` 表示“已知 RED”，不是通过；ROOT 修复后会 XPASS，需移除标记。
5. **正向控制**：普通查询仍 L0、`DB_PASSWORD=` 脱敏、审计 command 脱敏、`.env.example` 不误报。
6. **边界**：不演示真实 SSH/模型/Tauri；不把离线通过称为安全验收；未测项照实说明。

## 复现命令（示例）

```text
python run_newtests.py
```

runner 仅把临时 pylibs 与 sidecar 加入 `sys.path`，未改项目依赖。

## 材料索引

- 覆盖表：`06-验收与演示/01-测试记录/2026-11-18_EchoSinklair_TEAM-REVIEW-01_覆盖表.md`
- 补证矩阵：`06-验收与演示/01-测试记录/2026-11-18_EchoSinklair_TEAM-REVIEW-01_评审补证矩阵.md`
- 链路图：`05-作品材料/03-架构与图表/EchoSinklair/2026-11-18_EchoSinklair_TEAM-REVIEW-01_Agent链路图.md`
- 更新说明：`docs/updates/2026-11-18-TEAM-REVIEW-01-离线回归补证.md`
