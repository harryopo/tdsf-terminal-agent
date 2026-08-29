# 知识库使用说明

> 入口：左侧边栏 → 知识库。本页解释知识库的内容来源、文件式浏览、搜索用法。

## 内容来源（分好类的四类）

知识库面板按**来源分组**展示，每组可折叠：

| 来源分组 | 内容 | 性质 |
|---------|------|------|
| **内置教学文档**（builtin-docs） | 12 篇自编教学文档：Linux 底层逻辑速查、三级 Linux 复习资料、命令词源、FHS 目录逻辑、设计模式等 | 项目自编教学语料 |
| **内置命令卡片**（builtin-corpus） | 12 条命令/概念卡片（linux-core.json） | 项目自编 |
| **爬取文档**（`<名称>-docs`） | 官方文档站抓取：nginx / docker / systemd / bash / ssh / selinux / mysql / redis / kubernetes 等 14 个源 | 官方文档 |
| **会话沉淀**（case-*） | Agent 会话中沉淀的排障案例（T14 会话记忆） | 动态生成 |

> 诚实说明：内置教学文档是**项目自编**的教学语料（贴合课程），不是官方文档原文；官方文档通过"爬取文档"来源进入知识库。每条内容的来源标签在列表中可见。

## 文件式浏览（分片聚合）

一篇长文档入库时会被切分为多个分块（按标题边界，章内聚合），但浏览时**按文件聚合**：

1. 展开「内置教学文档」等含文件的分组 → 列出**文件**（文件名 + 首个标题 + 共 N 块 · 约 X 字）
2. 点文件 → 弹窗显示**完整文档**（所有分块按序拼接，正常 markdown 排版滚动阅读）
3. 顶部显示「共 N 块 · 约 X 字」元信息

命令卡片/会话沉淀这类没有"文件"概念的来源，仍按条目直接展示。

## 搜索

- 搜索框输入关键词 → 按分块命中（FTS5 中文分词 + 语义双路）
- 命中条目显示**所属文件名**徽章；点击带文件的命中 → 弹窗显示完整文档 + "来自搜索命中，第 N 块"定位提示
- 清空搜索自动回到文件式浏览

## 爬取官方文档（进阶）

内置 14 个官方文档源（每个最多 30 页、深度 2、限速 1s）：nginx / apache / mysql / redis / docker / kubernetes / systemd / selinux / iptables / ssh / bash / python / rust / git。

运维脚本（开发机）：

```powershell
cd src-tauri/sidecar
.venv\Scripts\python.exe scripts\rebuild_knowledge.py --no-clear --crawl-all   # 全部源
.venv\Scripts\python.exe scripts\rebuild_knowledge.py --no-clear --crawl docker-docs  # 单个源
```

注意：爬取受网络环境影响，失败的源会有 warning 日志，重跑即可补抓。

## 导入自己的文档

知识库支持导入本地 md 文档（`imported-docs` 来源），导入后自动按标题边界分块并进入"导入文档"分组。
