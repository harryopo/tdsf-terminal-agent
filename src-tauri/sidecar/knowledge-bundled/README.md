# 随包分发的精简知识库（`rag_slim.db`）

**这是什么**：一份预建好的 SQLite 库（247 条中文提炼知识点，FTS5 + 向量同库同 schema）。
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

**内容构成与分发范围**（2026-09-29 逐源核许可后收口的结果）：

这份随包库现在只有 **247 条**，来自 5 个**确认可再分发**的来源 ——
`philosophy` 108（本项目自撰）、`apache-docs` 64（Apache-2.0）、`docker-docs` 27（Apache-2.0）、
`kubernetes-docs` 26（文档 CC BY 4.0）、`firewalld-docs` 22（Unlicense）。
授权义务与出处逐条列在 **`THIRD-PARTY-NOTICES.md`**（同目录，随包一起分发）。

原先的 660 条里有 **413 条被剪掉**，判定与依据的唯一主人是 `knowledge/bundled_scope.py`：

| 被剪掉的来源 | 原因（要点） |
|---|---|
| `redis-docs` 85 | 站点条款**明文禁止** republish/redistribute，内容仅限个人/公司内部使用 |
| `archwiki` 141 | **GNU FDL 1.3+**（先前记成"CC BY-SA"是错的）：衍生作品须同许可 + 附许可全文 |
| `selinux-docs` 34 | Gentoo Wiki 为 CC BY-SA 4.0 ⇒ SA 与本仓库 Apache-2.0 口径冲突 |
| `bash-docs` 24 | GNU FDL 1.3（`bashref` 手册） |
| `git-docs` 19 | Pro Git 全书 CC BY-NC-SA 3.0 ⇒ NC + SA |
| `ssh-docs` 38 / `iptables-docs` 38 / `systemd-docs` 16 / `dnf-docs` 18 | **找不到覆盖文档文字的许可授予** ⇒ 按"未获授权"处理（fail-closed） |

三条判定口径（改之前先读 `bundled_scope.py` 的 docstring）：
**"没找到许可"＝未获授权**；**SA/copyleft 一律不随包**；**NC 也不随包**（不依赖"我们暂时不收费"这种前提）。
被剪掉的内容**用户仍可在本机自行抓取** —— 应用的爬取管线一条都没动，删的只是"我们预先做好分发"这一段。

剪枝连同两张派生表一起做（`scripts/prune_bundled_knowledge.py`，默认演练、`--write` 才替换）：
`doc_titles_zh` 删无主标题行、`embed_cache` 整表清空（它存着被删正文的向量表示，运行时不需要）。
随包件因此从 10,788,864 B 降到 **4,079,616 B**。


**改这个文件规矩**：不要手工编辑、不要直接覆盖开发机的 `.tdsf-data/rag_slim.db`。
重新生成后替换本文件，并同步跑 `tests/test_bundled_knowledge_seed.py`
（里面有"打开来数条目"的真件判据，条目数掉下 200 会当场红）。
