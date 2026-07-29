# 开源许可与魔改说明（Open Source & Modifications）

> 用途：比赛提交 / 开源合规的正式说明。说明本项目与上游开源项目的关系、许可义务，以及本项目的实质性原创贡献。
> 最后更新：2026-07-30

---

## 1. 上游来源

- **本项目基于开源项目 [`crynta/terax-ai`](https://github.com/crynta/terax-ai) v0.8.6 二次开发（魔改）**。
- 上游许可证：**Apache License 2.0**（本仓库根目录 `LICENSE` 保留其全文；`src/` 多处源文件头部保留 `Copyright ... Crynta` + Apache-2.0 声明）。
- 本项目属于 Apache-2.0 定义下的 **Derivative Work（衍生作品）**。

## 2. Apache-2.0 许可义务（本项目已/应遵守）

| 义务 | 状态 |
|------|------|
| 保留 `LICENSE`（Apache-2.0 全文） | ✅ 已保留（仓库根 `LICENSE`） |
| 保留原始版权声明（源文件头 `Copyright ... Crynta`） | ✅ 魔改时保留 |
| **显著标注已修改**（对修改过的上游文件注明变更） | ⚠️ 建议补：源文件用 `TDSF 魔改` 注释标注（现有部分文件已有），并以本文件 §3 汇总 |
| 提供 **`NOTICE`** 文件（若分发） | ⚠️ **待补**：建议新增 `NOTICE`，注明"本产品包含 crynta/terax-ai（Apache-2.0）的作品，版权归 Crynta；本项目为其衍生并做了修改" |
| 不使用上游名称/商标做背书 | ✅ 产品名改为 TDSF Terminal Agent |

## 3. 本项目的实质性原创贡献（"站在巨人肩膀上"的魔改）

在 terax 终端框架之上，本项目新增/重构了大量面向 **Linux 运维教学** 的能力（非上游原有）：

1. **TDSF Linux 运维教学 AI Agent 体系**：Python sidecar（`src-tauri/sidecar/`）AI 引擎 + 多 Agent（coding/explore/history/teach 等）+ 统一主 Agent 路由（PAOR 监督）+ RiskEngine 高危命令拦截。
2. **SSH 远程运维一体化**：russh 0.61 SSH 客户端 + SFTP 远程文件资源管理器 + 系统密钥库凭据持久化（keyring）+ TOFU 主机指纹验证（randomart）+ 远程文件在线编辑保存。
3. **离线中文选词翻译**：Linux 命令 + 编程术语双词典（`src/modules/translate/`），零网络依赖，面向中文运维学习者。
4. **终端能力强化**：xterm 渲染池复用、Shell 集成、命令块追踪。
5. **产品化改造**：品牌/UI 中文化、主题系统扩展、启动引导欢迎页、Windows 打包等。

> 说明：以上为本项目相对上游的净增价值；终端框架、窗口壳、部分 UI 基元沿用并改造自 terax（Apache-2.0）。

## 4. 提交前合规清单

- [ ] `LICENSE`（Apache-2.0）保留完整。
- [ ] 新增 `NOTICE`，注明衍生自 crynta/terax-ai 及版权。
- [ ] `README` / 项目说明注明"基于 crynta/terax-ai (Apache-2.0) 二次开发"。
- [ ] 修改过的上游文件保留原版权头 + 标注修改（本文件 §3 已汇总修改范围）。
- [ ] 第三方依赖许可核对（package.json 依赖多为 MIT/Apache-2.0，Cargo 依赖 russh/tauri 等为 Apache-2.0/MIT，均兼容）。

## 5. 建议动作（合规最小集）

1. 新增仓库根 `NOTICE` 文件（示例）：
   ```
   TDSF Terminal Agent
   Copyright 2026 TDSF Team

   本产品为衍生作品，基于 Crynta 的 terax-ai (https://github.com/crynta/terax-ai)，
   原作品采用 Apache License 2.0，版权归 Crynta 所有。
   本项目在其基础上进行了修改与扩展，修改说明见 docs/OPEN-SOURCE-AND-MODIFICATIONS.md。
   ```
2. `README`（如后续重建）首段注明上游与许可。
3. 比赛材料中，用 §3 阐述"原创贡献"，用 §1/§2 阐述"合规使用开源"。
