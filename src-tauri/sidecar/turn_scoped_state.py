"""turn_scoped_state.py — 沉淀进知识库的文本里，删掉"本轮即时状态"那几句（#147）

为什么需要这层机械清洗：#146 把"别把即时状态写进记忆"的要求写进了
``session_memory._SUMMARY_PROMPT``，但实测存量库（``.tdsf-data/rag.db`` 的 ``entries``
表）里那几条现在时断言**有两类根本不是 LLM 摘要写进去的**：

  1. ``source=auto-case`` —— ``adapter._auto_sink_case`` 把助手最终文本逐字塞进
     ``## 结论``（而它的触发词表里就有「无法」「不行」⇒ 一次"我做不了"的回合
     特别容易被判成"一个案例"沉淀下来）；
  2. ``source=session-memory`` 且内容以 ``[会话摘要·截断]`` 开头 —— LLM 不可用时
     ``session_memory._fallback_summary`` 把整段对话逐字截断存进去。

这两条路上"提示词里写了要求"完全不起作用（一条压根不调 LLM，一条不发给 LLM），
所以要在**写库之前**做一层与模型无关的清洗。读侧另有挡箭牌
（``ai/lib/transport.ts`` 的时态声明），两层各管一段。

**粒度=整句**（以 。。！？；换行 为界）：只删"三个条件同时成立"的句子，
其余**逐字保留**。不做子句级裁剪 —— 那会在句中留下"…限制：…提问，也不会…"
这类断头残渣，比留着原句更难读。
"""
from __future__ import annotations

import re

# 句子边界：保留终止符，回拼时形状不变（；也算边界 —— 中文长句里它就是分号分段）
_SENT_SPLIT = re.compile(r"(?<=[。！？!?；;\n])")

# 三个条件同时成立才删，任一缺失就整句保留（**宁漏不误删**）：
_CAPABILITY_NOUN = re.compile(
    r"工具|工具集|命令卡|执行类|shell|ssh_command|MCP|接口|函数"
)
_UNAVAILABLE = re.compile(
    r"没有|不带|无可用|不可用|用不了|不支持|被禁止|禁止|已从|移除|剔除|裁掉"
    r"|无法生成|无法执行|无法运行|无法调用|拿不到|只有|仅有|仅限"
    r"|Unknown tool"
)
_TURN_SCOPED = re.compile(
    r"本轮|这一轮|这次|本次|当前|此刻|现在|我这边|我这里|助手侧|工具集"
)


def _is_turn_scoped_limit(sentence: str) -> bool:
    return bool(
        _CAPABILITY_NOUN.search(sentence)
        and _UNAVAILABLE.search(sentence)
        and _TURN_SCOPED.search(sentence)
    )


def drop_turn_scoped_state(text: str) -> str:
    """删掉"声称本轮工具/能力不可用"的句子，其余逐字保留。

    没命中时返回**原串本身**（不裁剪空白、不改标点）—— 这样"清洗没生效"和
    "清洗顺手改了格式"在测试里是两件事，不会混成一个。
    """
    if not text:
        return text
    out: list[str] = []
    touched = False
    for sentence in _SENT_SPLIT.split(text):
        if not sentence:
            continue
        if _is_turn_scoped_limit(sentence):
            touched = True
            continue
        out.append(sentence)
    if not touched:
        return text
    return "".join(out)
