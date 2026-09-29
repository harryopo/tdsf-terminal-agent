# 随包知识库的第三方声明（`knowledge-bundled/rag_slim.db`）

本文件随安装包分发（`tdsf-sidecar.spec` 的 `datas` 带上整个 `knowledge-bundled/` 目录）。
库里存放的是**本项目自撰的教学语料**与**若干上游公开文档的中文提炼条目**。
每个来源的授权判定、依据 URL 与"为什么不随包"，唯一主人是
[`knowledge/bundled_scope.py`](../knowledge/bundled_scope.py)；本文件是它的可读副本，
判据 `tests/test_bundled_knowledge_seed.py` 会核对两处来源名单一致（防止"名单改了、声明没改"）。

## 一、随包分发的来源（5 个，247 条）

| source | 条数 | 许可 | 本项目的履行方式 |
|---|---|---|---|
| `philosophy` | 108 | 本项目自撰 | 随仓库 Apache-2.0 分发；源码在 `knowledge/philosophy/` |
| `apache-docs` | 64 | Apache License 2.0 | 见下节"许可全文与出处"；保留上游版权声明与许可指向 |
| `docker-docs` | 27 | Apache License 2.0 | 同上（版权行：Copyright 2013-2026 Docker, Inc.） |
| `kubernetes-docs` | 26 | CC BY 4.0（**仅文档**；代码是 Apache-2.0） | 署名：Documentation Copyright The Kubernetes Authors；许可指向 https://creativecommons.org/licenses/by/4.0/ ；条目为本项目的中文改写，已按 CC BY 要求标注"已修改" |
| `firewalld-docs` | 22 | The Unlicense（公共领域奉献） | 无署名义务；仍记录出处便于溯源 |

许可全文与出处：

- Apache License 2.0 全文：https://www.apache.org/licenses/LICENSE-2.0
  - Apache HTTP Server 文档：<https://httpd.apache.org/docs/2.4/>（页脚声明 Apache License 2.0）
  - Docker 文档：许可声明见其文档源码仓库 README
    <https://raw.githubusercontent.com/docker/docs/main/README.md>
    （"Copyright 2013-2026 Docker, Inc., released under the Apache 2.0 license"），
    线上文档站为 <https://docs.docker.com/>
- CC BY 4.0 全文：https://creativecommons.org/licenses/by/4.0/
  - Kubernetes 文档：<https://kubernetes.io/docs/home/>（页脚：Documentation Distributed under CC BY 4.0）
  - 另受 Linux 基金会商标政策约束：本项目不暗示 Kubernetes 官方背书。
- The Unlicense：<https://firewalld.org/documentation/>（站点声明 All website content subject to the Unlicense）

## 二、**不**随包分发的来源（已从随包件里删除，共 413 条）

这些内容仍可由用户在本机自行抓取（应用的爬取管线照旧），但本项目**不再预建、不再打包**。
原因逐条列在下面 —— 每条都有可点开的依据。

| source | 原条数 | 为什么不打进包 | 依据 |
|---|---|---|---|
| `redis-docs` | 85 | 站点条款**明文禁止**再分发/转载（"may not … republish, redistribute … without our prior written permission"），内容仅限个人/公司内部使用 | https://redis.io/legal/redis-website-terms-of-use/ |
| `git-docs` | 19 | Pro Git 全书 CC BY-NC-SA 3.0：NC（非商业）+ SA（相同方式共享），与 Apache-2.0 仓库口径直接冲突 | https://git-scm.com/book/en/v2 |
| `archwiki` | 141 | GNU FDL 1.3 or later：衍生作品须以同一许可发布、须附许可全文并保留全部版权声明（copyleft） | https://wiki.archlinux.org/title/ArchWiki:Copyrights |
| `bash-docs` | 24 | GNU FDL 1.3（`bashref` 参考手册），同 FDL 义务 | https://sources.debian.org/src/bash/unstable/debian/copyright/ |
| `selinux-docs` | 34 | Gentoo Wiki 为 CC BY-SA 4.0：SA 要求改编版仍以 BY-SA 共享 | https://wiki.gentoo.org/wiki/SELinux |
| `ssh-docs` | 38 | **找不到覆盖 man page 文字的许可授予**（OpenBSD policy 只讲代码）⇒ 按"未获授权"处理 | https://www.openbsd.org/policy.html |
| `iptables-docs` | 38 | 站点只有版权行，无文档许可声明（about#license 的 GPLv2 说的是软件） | https://www.netfilter.org/documentation/ |
| `systemd-docs` | 16 | 未见上游对文档文字的自述许可（发行包把 LGPL 记在整棵树上，套到文档属归类可疑）⇒ 按未获授权处理 | https://sources.debian.org/src/systemd/unstable/debian/copyright/ |
| `dnf-docs` | 18 | 同上（readthedocs 页无许可脚注，发行包记 GPL-2+） | https://sources.debian.org/src/dnf/unstable/debian/copyright/ |

判定口径三条，别改回去：

1. **"没找到许可"＝未获授权**，不等于"可以随便用"（fail-closed 方向）。
2. **SA / copyleft 一律不随包**：随包件位于 Apache-2.0 仓库与安装包内，无法同时满足"以同一许可共享"。
3. **NC 也不随包**：NC 判据是用途是否"主要旨在商业优势或金钱报酬"（CC BY-NC-SA 4.0 §1(a)），
   当前安装包免费、无广告，属于可辩护地带；但本仓库与产品未排除后续收费形态，
   且 SA 一条本身就足以否掉打包 ⇒ 不依赖"我们暂时不收费"这种前提。

## 三、随包件里已经不存在的派生数据

剪枝不只删 `entries`：

- `doc_titles_zh` 里**无主**的标题行（对应被删来源）一并删除；
- `embed_cache`（content→向量 的复用缓存，运行时不需要）在随包件里**整表清空** ——
  它存着被删正文的向量表示，属于原作品的衍生数据。

复检方式（脚本自带）：`scripts/prune_bundled_knowledge.py`。
