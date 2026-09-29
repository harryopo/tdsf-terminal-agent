# 随包分发的精简知识库（`rag_slim.db`）

**这是什么**：一份预建好的 SQLite 库（660 条中文提炼知识点，FTS5 + 向量同库同 schema）。
应用首次启动时由 `knowledge/bundled.py:seed_bundled_slim_db()` **复制**到可写数据目录
（Windows：`%APPDATA%\tdsf-terminal-agent\.tdsf-data\rag_slim.db`），**目标已存在就一个字都不动**。

**为什么要随包**（#166 ⑥，2026-09-29 装机验收报"没看到知识库的内容"）：
运行时读的是 `<TDSF_DATA_DIR>/rag_slim.db`，而它过去只躺在开发机的 `.tdsf-data/`（gitignore 内），
打包链里没有任何 `.db`；启动自动初始化只爬**全量库** `rag.db`，精简库空时只打一条 warning
—— 而前端知识浏览器与 agent 检索**主读精简库**，所以新装的机器上那一格就是空的。

**怎么生成的**（离线一次性，不在启动流程里跑，因为要调大模型）：

```
src-tauri/sidecar/scripts/consolidate_knowledge.py      # 全量库 → 合并 md
src-tauri/sidecar/scripts/rebuild_from_consolidated.py  # 合并 md → 分块入库
src-tauri/sidecar/scripts/distill_knowledge.py          # LLM 每章提炼中文知识点
src-tauri/sidecar/scripts/insert_manual_distill.py      # 人工补写条目
src-tauri/sidecar/scripts/fill_slim_titles.py           # 中文标题映射与占位块清理
```

**内容构成**（当轮从这份 db 里 `group by source` 实测，共 660 条）：
`philosophy` 108（自撰教学语料）、`archwiki` 141、`redis-docs` 85、`apache-docs` 64、
`ssh-docs` 38、`iptables-docs` 38、`selinux-docs` 34、`docker-docs` 27、`kubernetes-docs` 26、
`bash-docs` 24、`firewalld-docs` 22、`git-docs` 19、`dnf-docs` 18、`systemd-docs` 16。

> ⚠️ **再分发许可还没核过**：这些上游文档各自的授权不同（例如 Arch Wiki 是 CC BY-SA、
> Redis 文档是 CC BY-NC-SA 一类的非商业许可），而本仓库以 Apache-2.0 公开分发。
> 把提炼后的内容随安装包公开分发之前，需要逐源确认署名与许可要求。
> 这条是**已知未办**，不是"已经合规"。

**改这个文件规矩**：不要手工编辑、不要直接覆盖开发机的 `.tdsf-data/rag_slim.db`。
重新生成后替换本文件，并同步跑 `tests/test_bundled_knowledge_seed.py`
（里面有"打开来数条目"的真件判据，条目数掉下 600 会当场红）。
