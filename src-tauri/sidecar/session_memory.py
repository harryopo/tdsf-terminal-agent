"""
session_memory.py — 会话记忆沉淀服务（方案书 v3.0 T14，2026-08-28）
====================================================================

职责（方案书 v3.0 §5 T14）：
1. **summarize_session**：会话结束（或达到轮次阈值）时由前端触发，
   用 LLM 把会话 transcript 压缩为结构化摘要（现象 → 根因 → 解法 → 教学要点），
   写入统一 RAG 决策库（source="session-memory"）。
   - 幂等：条目 id 固定为 ``session-memory-<session_id>``，
     rag.add 对同 id 走 INSERT OR REPLACE（确定性 rowid），同会话重复摘要自动覆盖。
2. **save_session_skill**：把摘要/经验一键沉淀为 SKILL.md 技能包
   （落 ``~/.tdsf/skills/<name>/SKILL.md``），随后热重载全局技能注册表——
   沉淀的技能无需重启即被 skill_invoke 调用（T1 加载器已支持用户目录）。

JSON-RPC 方法（register_methods 注册，前端经 ipc_invoke 调用）：
- memory.summarize_session: {session_id, transcript, title?} → {ok, case_id, summary}
- memory.save_skill:        {name, description, content, triggers?, allowed_tools?}
                            → {ok, skill_name, path, reloaded}

LLM 调用：OpenAI 兼容 /chat/completions 直调（与 long_context 同模式），
配置取 core.llm_config.load_config（is_configured=False 时回退截断摘要，离线可用）。
"""
from __future__ import annotations

import json
import logging
import re
import urllib.request
from pathlib import Path
from typing import Any

logger = logging.getLogger("sidecar.session_memory")

# 会话记忆条目 id 前缀（幂等 key：同 session 重复摘要 = 覆盖）
_MEMORY_ID_PREFIX = "session-memory-"
# 用户技能目录（与 skills/registry._USER_SKILLS_DIR 同源；独立常量避免私有依赖）
_USER_SKILLS_DIR = Path.home() / ".tdsf" / "skills"
# 技能名约束：小写字母/数字开头，允许连字符，2~49 字符（防路径穿越/非法文件名）
_SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,48}$")
# LLM 不可用时的摘要回退长度（字符）
_FALLBACK_SUMMARY_CHARS = 800


# ============================================================================
# LLM 调用（OpenAI 兼容直调）
# ============================================================================

def _llm_complete(prompt: str, max_tokens: int = 1024) -> str | None:
    """用已配置的 LLM 补全一段文本（失败返回 None，调用方自行回退）。

    与 long_context._llm_summarize 同模式，但 base_url 走
    llm_config._resolve_base_url（国产 provider 官方端点回退），
    且不做"文本未超长直接返回原文"的短路（会话摘要短也要格式化）。
    """
    try:
        from core.llm_config import load_config

        config = load_config()
        if not config.is_configured:
            return None

        url = f"{config.base_url or 'https://api.openai.com/v1'}/chat/completions"
        payload = json.dumps({
            "model": config.model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.3,
        }).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {config.api_key}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
            return content.strip() or None
    except Exception as e:  # noqa: BLE001 — LLM 失败必须回退，不中断沉淀
        logger.warning(f"llm_complete failed, fallback summary used: {e}")
        return None


# ============================================================================
# transcript 处理
# ============================================================================

def _transcript_to_text(transcript: list[dict[str, Any]]) -> str:
    """把前端传来的消息列表压缩为摘要输入文本。

    Args:
        transcript: [{role: "user"|"assistant", content: str}, ...]
                    （前端已裁剪；tool 调用等细节消息由前端过滤）

    Returns:
        逐行 "【用户】/【助手】" 文本；总长超 16000 字符时保首尾
        （首 40% + 尾 40%，中间省略——与 long_context 同策略）。
    """
    lines: list[str] = []
    for m in transcript:
        role = str(m.get("role", "user"))
        content = str(m.get("content", "")).strip()
        if not content:
            continue
        tag = "【用户】" if role == "user" else "【助手】"
        lines.append(f"{tag}{content}")

    text = "\n\n".join(lines)
    max_chars = 16000
    if len(text) > max_chars:
        head = text[: int(max_chars * 0.4)]
        tail = text[-int(max_chars * 0.4):]
        text = f"{head}\n\n…[中间内容省略 {len(text) - max_chars} 字符]…\n\n{tail}"
    return text


_SUMMARY_PROMPT = (
    "你是 Linux 运维教学助手的会话记录员。请把以下师生对话压缩为一份结构化摘要，"
    "供未来排查类似问题时检索参考。摘要必须包含以下小节（没有的小节写「无」）：\n"
    "## 问题现象\n## 根因分析\n## 解决命令（逐条列出实际用到的命令）\n## 教学要点\n\n"
    "要求：忠实于对话内容，不编造；命令保留原样；总长 500 字以内。\n\n---\n\n{transcript}"
)


def _fallback_summary(text: str) -> str:
    """LLM 不可用时的截断摘要（保证沉淀链路离线可用）"""
    truncated = text[:_FALLBACK_SUMMARY_CHARS]
    return f"[会话摘要·截断] {truncated}"


# ============================================================================
# 核心能力 1：会话摘要沉淀
# ============================================================================

def summarize_session(
    session_id: str,
    transcript: list[dict[str, Any]],
    title: str | None = None,
    scope_id: str | None = None,
) -> dict[str, Any]:
    """把会话 transcript 摘要后写入决策库（幂等）。

    Args:
        session_id: 会话 id（幂等 key 的一部分）
        transcript: [{role, content}, ...] 消息列表（前端裁剪后）
        title: 可选标题（None 时自动取"会话记忆：<首条用户消息前 40 字>"）
        scope_id: 工作区 id（A1 隔离，可选）——提供时给条目打
            ``workspace:<scope_id>`` 标签，recall 按工作区过滤可见性；
            None = 不打标签（存量全局行为）

    Returns:
        {ok, case_id, summary, reused}
        - reused=True 表示该会话之前已沉淀，本次为覆盖更新
    """
    if not session_id or not str(session_id).strip():
        return {"ok": False, "error": "session_id is required"}
    session_id = str(session_id).strip()

    text = _transcript_to_text(transcript or [])
    if not text:
        return {"ok": False, "error": "transcript is empty"}

    # 幂等探测：RAG 已有同 id 条目则标记 reused（id 相同 rag.add 本身就是覆盖）
    case_id = f"{_MEMORY_ID_PREFIX}{session_id}"
    reused = False
    try:
        from knowledge.rag import get_global_rag

        rag = get_global_rag()
        existing = rag.get(case_id)
        reused = existing is not None
    except Exception as e:  # noqa: BLE001 — 探测失败不阻塞写入
        logger.warning(f"reuse probe failed (treat as new): {e}")

    # 标题：优先用户传入，否则取首条用户消息片段
    if not title or not str(title).strip():
        first_user = next(
            (str(m.get("content", "")).strip() for m in transcript if m.get("role") == "user"),
            "",
        )
        title = f"会话记忆：{first_user[:40]}" + ("…" if len(first_user) > 40 else "")

    summary = _llm_complete(_SUMMARY_PROMPT.format(transcript=text), max_tokens=1024)
    if not summary:
        summary = _fallback_summary(text)

    try:
        from knowledge.fts5 import KnowledgeEntry
        from knowledge.rag import get_global_rag

        entry = KnowledgeEntry(
            id=case_id,
            source="session-memory",
            title=str(title),
            content=summary,
            # A1 工作区隔离: scope_id 存在时打 workspace 标签（recall 过滤维度）
            tags=[
                "会话记忆",
                f"session:{session_id}",
                *( [f"workspace:{scope_id}"] if scope_id else [] ),
            ],
        )
        get_global_rag().add(entry)
        logger.info(f"session memory saved: {case_id} (reused={reused})")
        return {"ok": True, "case_id": case_id, "summary": summary, "reused": reused}
    except Exception as e:  # noqa: BLE001
        logger.exception(f"session memory write failed: {e}")
        return {"ok": False, "error": str(e)}


# ============================================================================
# 核心能力 2：摘要 → SKILL.md 技能包沉淀（B3 /summary-to-skill 合并设计）
# ============================================================================

def save_session_skill(
    name: str,
    description: str,
    content: str,
    triggers: list[str] | None = None,
    allowed_tools: list[str] | None = None,
) -> dict[str, Any]:
    """把经验沉淀为 SKILL.md 技能包并热重载注册表。

    落盘 ``~/.tdsf/skills/<name>/SKILL.md``（T1 load_external_dir 模式 1），
    随后调用 reload_global_registry()——沉淀的技能无需重启即被 skill_invoke 调用。

    Args:
        name: 技能名（^[a-z0-9][a-z0-9-]{1,48}$，如 "nginx-502-troubleshoot"）
        description: 一句话描述（frontmatter description）
        content: 正文 Markdown（步骤/命令/注意事项）
        triggers: 触发词列表（可选，search 命中用）
        allowed_tools: 工具白名单（可选，空 = 不限制）

    Returns:
        {ok, skill_name, path, reloaded}
    """
    name = str(name or "").strip()
    if not _SKILL_NAME_RE.match(name):
        return {
            "ok": False,
            "error": (
                f"invalid skill name: '{name}' "
                "(需匹配 ^[a-z0-9][a-z0-9-]{1,48}$，如 nginx-502-troubleshoot)"
            ),
        }
    description = str(description or "").strip()
    content = str(content or "").strip()
    if not description or not content:
        return {"ok": False, "error": "description and content are required"}

    # frontmatter（与 skills/parser.py 解析字段对齐）
    fm_lines = [
        "---",
        f"name: {name}",
        f"description: {description}",
        "version: 1.0.0",
        "author: tdsf-session-memory",
    ]
    tags = ["会话沉淀"]
    if triggers:
        tags.append("触发词:" + ",".join(str(t) for t in triggers[:10]))
    fm_lines.append("tags: [" + ", ".join(tags) + "]")
    if triggers:
        fm_lines.append(
            "triggers: [" + ", ".join(str(t) for t in triggers[:10]) + "]"
        )
    if allowed_tools:
        fm_lines.append(
            "allowed-tools: [" + ", ".join(str(t) for t in allowed_tools[:20]) + "]"
        )
    fm_lines.append("---")

    skill_md = "\n".join(fm_lines) + "\n\n" + content + "\n"

    try:
        skill_dir = _USER_SKILLS_DIR / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        path = skill_dir / "SKILL.md"
        path.write_text(skill_md, encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        logger.exception(f"save_session_skill write failed: {e}")
        return {"ok": False, "error": f"write failed: {e}"}

    # 热重载（失败不回滚文件——下次 sidecar 启动/手动 reload 仍会生效）
    reloaded = False
    try:
        from skills.registry import reload_global_registry

        reload_global_registry()
        reloaded = True
    except Exception as e:  # noqa: BLE001
        logger.warning(f"skill registry reload failed (file saved): {e}")

    logger.info(f"session skill saved: {name} -> {path} (reloaded={reloaded})")
    return {"ok": True, "skill_name": name, "path": str(path), "reloaded": reloaded}


# ============================================================================
# JSON-RPC 注册
# ============================================================================

def register_methods(dispatcher: Any) -> None:
    """注册 memory.* JSON-RPC 方法（main.register_business_methods 调用）"""

    # 注意：MethodDispatcher.dispatch 对 dict params 走 handler(**params) 解包，
    # handler 必须用具名参数（与 knowledge.rpc._add_case 同模式）
    def _summarize(
        session_id: str,
        transcript: list[dict[str, Any]] | None = None,
        title: str | None = None,
        scope_id: str | None = None,
    ) -> dict[str, Any]:
        return summarize_session(
            session_id=str(session_id or ""),
            transcript=list(transcript or []),
            title=title,
            scope_id=(str(scope_id).strip() or None) if scope_id else None,
        )

    def _save_skill(
        name: str,
        description: str,
        content: str,
        triggers: list[str] | None = None,
        allowed_tools: list[str] | None = None,
    ) -> dict[str, Any]:
        return save_session_skill(
            name=str(name or ""),
            description=str(description or ""),
            content=str(content or ""),
            triggers=triggers,
            allowed_tools=allowed_tools,
        )

    dispatcher.register("memory.summarize_session", _summarize)
    dispatcher.register("memory.save_skill", _save_skill)
    logger.info("memory.* methods registered (summarize_session / save_skill)")
