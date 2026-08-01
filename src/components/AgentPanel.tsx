/**
 * AgentPanel.tsx — AI 助手浮动面板 (P2-A 接入真实 Agent)
 * -----------------------------------------------------------------------------
 * 设计稿: view-expanded.html L309-455
 *
 * 布局 (3 段):
 *   ① Header 40px  — mood + Agent 标签 + 风险等级 + 模型 + tokens + 按钮
 *   ② Messages     — 用户消息 + Agent 回复 + 工具调用卡片 + needs-you 通知
 *   ③ Input  56px  — 输入框 + 发送按钮 + @/#// 快捷方式
 *
 * P2-A 变更（T-P2-01）:
 *   - 移除所有 mock 数据
 *   - 接入 sidecar-bridge 的 invokeRpc / subscribe
 *   - 通过 reducer 管理 agentMessages / toolCalls / needsYou
 *   - 输入框 Enter 提交 → 调用 agent.invoke JSON-RPC
 *   - 实时订阅 mood_change / agent_message / tool_call / needs_you 事件
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useRuntime } from '../store/runtime';
import {
  invokeRpc,
  parseIPCError,
  subscribe,
  isRunning,
} from '../lib/sidecar-bridge';
import type {
  AgentMessage,
  AgentMessageType,
  AgentStateItem,
  KnowledgeCardItem,
  ToolCallItem,
  ToolCallStatus,
} from '../store/runtime';

interface AgentPanelProps {
  open: boolean;
  onClose: () => void;
}

// === 工具调用状态颜色映射 ====================================================
const TOOL_STATUS_COLOR: Record<ToolCallStatus, string> = {
  running: 'var(--color-primary)',
  success: 'var(--color-success)',
  error: 'var(--color-error)',
  pending_approval: 'var(--color-warning)',
};

const TOOL_STATUS_LABEL: Record<ToolCallStatus, string> = {
  running: '执行中',
  success: '成功',
  error: '失败',
  pending_approval: '待审批',
};

// === mood → 表情符号映射 =====================================================
const MOOD_FACE: Record<string, string> = {
  idle: '⬡‿⬡',
  thinking: '⬡_⬡',
  stream: '⬡~⬡',
  working: '⬡○⬡',
  waiting: '⬡⏸⬡',
  done: '⬡‿⬡',
  error: '⬡✗⬡',
};

// === 风险等级颜色映射 ========================================================
const RISK_COLOR: Record<string, string> = {
  L0: 'var(--color-success)',
  L1: 'var(--color-success)',
  L2: 'var(--color-primary)',
  L3: 'var(--color-warning)',
  L4: 'var(--color-error)',
};

export function AgentPanel({ open, onClose }: AgentPanelProps) {
  const { state, dispatch } = useRuntime();
  const [input, setInput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const moodColor = `var(--color-mood-${state.mood})`;

  // === 订阅 Sidecar 事件（mood_change / agent_message / tool_call / needs_you） ===
  useEffect(() => {
    if (!open) return;

    const unlistens: Array<() => void> = [];

    // mood_change: 实时更新 mood
    subscribe('mood_change', (payload) => {
      const p = payload as { mood?: string; session_id?: string };
      if (p.mood) {
        dispatch({ type: 'set-mood', mood: p.mood as typeof state.mood });
      }
    }).then((un) => unlistens.push(un));

    // agent_message: 流式显示 Agent 输出
    subscribe('agent_message', (payload) => {
      const p = payload as {
        content?: string;
        type?: AgentMessageType;
        session_id?: string;
        agent_name?: string;
      };
      if (p.content) {
        dispatch({
          type: 'add-agent-message',
          message: {
            type: p.type ?? 'output',
            content: p.content,
            sessionId: p.session_id,
            agentName: p.agent_name,
          },
        });
      }
    }).then((un) => unlistens.push(un));

    // tool_call: 工具调用开始
    subscribe('tool_call', (payload) => {
      const p = payload as {
        tool_name?: string;
        params?: Record<string, unknown>;
        call_id?: string;
        risk_level?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
      };
      if (p.tool_name) {
        dispatch({
          type: 'add-tool-call',
          toolCall: {
            toolName: p.tool_name,
            params: p.params ?? {},
            status: 'running',
            riskLevel: p.risk_level,
          },
        });
      }
    }).then((un) => unlistens.push(un));

    // tool_call_result: 工具调用完成
    subscribe('tool_call_result', (payload) => {
      const p = payload as {
        tool_name?: string;
        result?: Record<string, unknown>;
        error?: string;
        risk_level?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
      };
      // 更新最近一个同名工具调用（status=running）
      // 通过倒序查找最后一个匹配项（兼容 ES2021 以下不支持 findLast）
      const tc = [...state.toolCalls]
        .reverse()
        .find(
          (t: ToolCallItem) =>
            t.toolName === p.tool_name && t.status === 'running',
        );
      if (tc) {
        dispatch({
          type: 'update-tool-call',
          id: tc.id,
          updates: {
            status: p.error ? 'error' : 'success',
            result: p.result,
            error: p.error,
            finishedAt: Date.now(),
            riskLevel: p.risk_level ?? tc.riskLevel,
          },
        });
      }
    }).then((un) => unlistens.push(un));

    // needs_you: 用户审批/问题/错误/handoff
    // P1-1 (2026-08-01): 后端事件带 id（needs_you 服务 req_id），
    // 卡片按钮据此调 needs_you.approve/reject RPC 实现真实审批闭环
    subscribe('needs_you', (payload) => {
      const p = payload as {
        type?: 'approval' | 'error' | 'question' | 'handoff';
        title?: string;
        detail?: string;
        id?: string;
        needs_type?: string;
        description?: string;
      };
      const type = p.type ?? p.needs_type;
      const detail = p.detail ?? p.description ?? '';
      if (type && p.title) {
        dispatch({
          type: 'add-needs-you',
          item: {
            id: p.id, // 后端 req_id（approve/reject RPC 用）
            type: type as 'approval' | 'error' | 'question' | 'handoff',
            title: p.title,
            detail,
          },
        });
      }
    }).then((un) => unlistens.push(un));

    // T-P3-08: knowledge_cards — observe_node 自动检索知识库后推送
    // 每轮 observe 重新推送（覆盖式更新），清空旧卡片后渲染新卡片
    subscribe('knowledge_cards', (payload) => {
      const p = payload as {
        cards?: Array<{
          title?: string;
          source?: string;
          snippet?: string;
          url?: string;
          score?: number;
          match_type?: 'fts5' | 'vector';
        }>;
        query?: string;
      };
      if (Array.isArray(p.cards)) {
        const cards: KnowledgeCardItem[] = p.cards.map((c) => ({
          title: c.title ?? '',
          source: c.source ?? '',
          snippet: c.snippet ?? '',
          url: c.url ?? '',
          score: typeof c.score === 'number' ? c.score : 0,
          matchType: c.match_type,
        }));
        dispatch({ type: 'set-knowledge-cards', cards });
      }
    }).then((un) => unlistens.push(un));

    return () => {
      unlistens.forEach((un) => un());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dispatch]);

  // === 自动滚动到底部（消息更新时） ============================================
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [state.agentMessages, state.toolCalls, state.needsYou]);

  // === 输入框提交 =============================================================
  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || state.agentBusy) return;

    setErrorMsg(null);

    // 1. 立即显示用户消息
    dispatch({
      type: 'add-agent-message',
      message: {
        type: 'output',
        content: text,
      },
    });

    // 2. 切换 mood → thinking, agentBusy → true
    dispatch({ type: 'set-mood', mood: 'thinking' });
    dispatch({ type: 'set-agent-busy', busy: true });

    // 3. 调用 agent.invoke JSON-RPC
    try {
      // 检查 Sidecar 是否运行
      const running = await isRunning();
      if (!running) {
        throw new Error('Sidecar 未运行，请等待启动或重启应用');
      }

      // 调用主 Agent
      // 参数: { name: 'main', state: { input, mode, session_id } }
      const result = await invokeRpc<{ next_step?: string; done?: boolean }>(
        'agent.invoke',
        {
          name: 'main',
          state: {
            input: text,
            mode: state.mode,
            session_id: state.currentSessionId || undefined,
            project_id: undefined,
          },
        },
      );

      // Agent 完成
      dispatch({ type: 'set-mood', mood: 'done' });

      // 若返回结果中包含最终输出，且未通过 agent_message 推送，则手动追加
      if (result?.next_step === 'done' && !state.agentMessages.some((m) => m.type === 'done')) {
        dispatch({
          type: 'add-agent-message',
          message: {
            type: 'done',
            content: '任务已完成',
          },
        });
      }
    } catch (e) {
      const ipcErr = parseIPCError(e as unknown);
      const msg =
        ipcErr.data?.type === 'not_running'
          ? 'Python Sidecar 未运行，请重启应用'
          : ipcErr.data?.type === 'timeout'
            ? '请求超时（30s），请稍后重试'
            : `Agent 调用失败: ${ipcErr.message}`;
      setErrorMsg(msg);
      dispatch({ type: 'set-mood', mood: 'error' });
      dispatch({
        type: 'add-agent-message',
        message: {
          type: 'error',
          content: msg,
        },
      });
    } finally {
      dispatch({ type: 'set-agent-busy', busy: false });
      setInput('');
      inputRef.current?.focus();
    }
  }, [input, state.agentBusy, state.mode, state.currentSessionId, state.agentMessages, dispatch]);

  // === 键盘事件 ===============================================================
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  if (!open) return null;

  // === 渲染 ===================================================================
  return (
    <aside
      className="fixed flex flex-col"
      id="ai-panel"
      style={{
        right: '12px',
        bottom: '36px',
        width: '420px',
        maxHeight: 'calc(100vh - 120px)',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border-strong)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-panel), var(--shadow-glow)',
        zIndex: 40,
        overflow: 'hidden',
        animation: 'panelIn 0.2s ease-out',
      }}
      data-testid="tdsf-agent-panel"
    >
      {/* ===== ① Header 40px ===== */}
      <div
        className="shrink-0 flex items-center gap-2 px-3"
        style={{ height: '40px', borderBottom: '1px solid var(--color-border)' }}
      >
        <span
          style={{
            color: moodColor,
            fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
            fontSize: '14px',
          }}
          data-testid="tdsf-agent-mood-face"
        >
          {MOOD_FACE[state.mood] ?? '⬡‿⬡'}
        </span>
        <span
          className="font-semibold"
          style={{ color: 'var(--color-text)', fontSize: '12px' }}
        >
          Agent
        </span>
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded font-medium"
          style={{
            background: 'var(--color-success-soft)',
            color: 'var(--color-success)',
            fontSize: '10px',
          }}
        >
          {state.mode.toUpperCase()}
        </span>
        <span style={{ color: 'var(--color-text-faint)', fontSize: '10px' }}>
          Claude 4.5
        </span>
        <span
          className="tabular-nums"
          style={{ color: 'var(--color-text-faint)', fontSize: '10px' }}
          data-testid="tdsf-agent-tokens"
        >
          {state.tokens.toLocaleString()}
        </span>
        {state.agentBusy && (
          <span
            className="inline-block"
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: 'var(--color-primary)',
              marginLeft: '2px',
              animation: 'spin 1.2s linear infinite',
            }}
            data-testid="tdsf-agent-busy-indicator"
          />
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-0.5">
          <button
            className="w-6 h-6 flex items-center justify-center rounded transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
            title="最小化"
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = 'rgba(91,140,255,0.1)')
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = 'transparent')
            }
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            className="w-6 h-6 flex items-center justify-center rounded transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
            title="清空对话"
            onClick={() => {
              dispatch({ type: 'clear-agent-state' });
              setErrorMsg(null);
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = 'rgba(91,140,255,0.1)')
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = 'transparent')
            }
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" />
            </svg>
          </button>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
            title="关闭"
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = 'rgba(248,113,113,0.15)')
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = 'transparent')
            }
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* ===== ② Messages ===== */}
      <div
        className="flex-1 overflow-y-auto px-3 py-3"
        style={{
          fontSize: '12px',
          lineHeight: 1.55,
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
        data-testid="tdsf-agent-messages"
      >
        {/* ===== T-P4-07: 9 子 Agent 状态卡片 ===== */}
        <SubAgentGrid agentStates={state.agentStates} />
        {/* 空状态提示 */}
        {state.agentMessages.length === 0 &&
          state.toolCalls.length === 0 &&
          state.needsYou.length === 0 && (
            <div
              style={{
                textAlign: 'center',
                color: 'var(--color-text-faint)',
                fontSize: '11px',
                padding: '20px 0',
              }}
            >
              <div style={{ fontSize: '24px', marginBottom: '8px' }}>⬡‿⬡</div>
              <div>我是 Linux 运维教学 Agent</div>
              <div style={{ marginTop: '4px' }}>
                输入问题（如「nginx 启动失败」）开始对话
              </div>
            </div>
          )}

        {/* 渲染消息列表（agentMessages + toolCalls + needsYou + knowledgeCards 按时间交错） */}
        <MessageList
          messages={state.agentMessages}
          toolCalls={state.toolCalls}
          needsYou={state.needsYou}
          knowledgeCards={state.knowledgeCards}
          onResolveNeedsYou={(id) =>
            dispatch({ type: 'resolve-needs-you', id })
          }
        />

        {/* 错误提示条 */}
        {errorMsg && (
          <div
            style={{
              padding: '6px 10px',
              background: 'rgba(248,113,113,0.1)',
              border: '1px solid rgba(248,113,113,0.3)',
              borderRadius: '6px',
              color: 'var(--color-error)',
              fontSize: '11px',
            }}
            data-testid="tdsf-agent-error"
          >
            {errorMsg}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ===== T-P4-06: SteerInject 输入框 ===== */}
      <SteerInjectBar disabled={!state.agentBusy} />

      {/* ===== ③ Input 56px ===== */}
      <div
        className="shrink-0 px-3 py-2"
        style={{ borderTop: '1px solid var(--color-border)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="flex-1 flex items-center gap-1.5 px-2.5 py-2 rounded-md"
            style={{
              background: 'var(--color-bg)',
              border: '1px solid rgba(91,140,255,0.15)',
            }}
          >
            <span
              style={{
                color: 'var(--color-primary)',
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                fontSize: '12px',
              }}
            >
              &gt;
            </span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                state.agentBusy ? 'Agent 执行中...' : '输入命令或问题...'
              }
              disabled={state.agentBusy}
              data-testid="tdsf-agent-input"
              maxLength={2000}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--color-text)',
                fontSize: '12px',
                fontFamily: 'inherit',
              }}
            />
            <span
              className="tabular-nums"
              style={{
                color: 'var(--color-text-faint)',
                fontSize: '10px',
              }}
            >
              {input.length}/2000
            </span>
          </div>
          <button
            onClick={() => void handleSubmit()}
            disabled={!input.trim() || state.agentBusy}
            className="flex items-center justify-center rounded-full transition-colors flex-shrink-0"
            style={{
              width: '28px',
              height: '28px',
              background:
                !input.trim() || state.agentBusy
                  ? 'var(--color-border)'
                  : 'var(--color-primary)',
              color: '#fff',
              cursor:
                !input.trim() || state.agentBusy ? 'not-allowed' : 'pointer',
            }}
            data-testid="tdsf-agent-send"
            title="发送 (Enter)"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <div
          className="flex items-center gap-2 mt-1.5 px-0.5"
          style={{ fontSize: '10px', color: 'var(--color-text-faint)' }}
        >
          <span
            className="flex items-center gap-0.5 cursor-pointer transition-colors"
            onMouseEnter={(e) =>
              (e.currentTarget.style.color = 'var(--color-primary)')
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = 'var(--color-text-faint)')
            }
          >
            <span
              style={{
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
              }}
            >
              @
            </span>{' '}
            提及文件
          </span>
          <span
            className="flex items-center gap-0.5 cursor-pointer transition-colors"
            onMouseEnter={(e) =>
              (e.currentTarget.style.color = 'var(--color-primary)')
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = 'var(--color-text-faint)')
            }
          >
            <span
              style={{
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
              }}
            >
              #
            </span>{' '}
            知识库
          </span>
          <span
            className="flex items-center gap-0.5 cursor-pointer transition-colors"
            onMouseEnter={(e) =>
              (e.currentTarget.style.color = 'var(--color-primary)')
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = 'var(--color-text-faint)')
            }
          >
            <span
              style={{
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
              }}
            >
              /
            </span>{' '}
            命令
          </span>
          <div className="flex-1" />
          <span className="flex items-center gap-0.5">
            <span
              style={{
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
              }}
            >
              ↵
            </span>{' '}
            发送
          </span>
        </div>
      </div>

      <style>{`
        @keyframes panelIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes caret-blink {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0; }
        }
      `}</style>
    </aside>
  );
}

// ============================================================================
// 子组件: MessageList — 消息列表渲染（按时间顺序交错显示）
// ============================================================================
interface MessageListProps {
  messages: AgentMessage[];
  toolCalls: ToolCallItem[];
  needsYou: import('../store/runtime').NeedsYouItem[];
  knowledgeCards: KnowledgeCardItem[];
  onResolveNeedsYou: (id: string) => void;
}

function MessageList({
  messages,
  toolCalls,
  needsYou,
  knowledgeCards,
  onResolveNeedsYou,
}: MessageListProps) {
  // 简化策略：先显示所有 Agent 消息，再显示工具调用，最后显示 needs-you
  // （时间顺序由 reducer 追加顺序保证，跨类型交错显示作为后续优化）
  return (
    <>
      {messages.map((msg) => (
        <AgentMessageItem key={msg.id} message={msg} />
      ))}

      {knowledgeCards.length > 0 && (
        <div
          style={{
            marginTop: '4px',
            paddingTop: '4px',
            borderTop: '1px dashed var(--color-border)',
          }}
          data-testid="tdsf-knowledge-cards-section"
        >
          <div
            style={{
              fontSize: '10px',
              color: 'var(--color-text-faint)',
              marginBottom: '6px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <span>&#x1F4DA;</span>
            <span>相关知识 ({knowledgeCards.length})</span>
          </div>
          {knowledgeCards.map((card, idx) => (
            <KnowledgeCardItemView key={`${card.title}-${idx}`} card={card} />
          ))}
        </div>
      )}

      {toolCalls.length > 0 && (
        <div
          style={{
            marginTop: '4px',
            paddingTop: '4px',
            borderTop: '1px dashed var(--color-border)',
          }}
        >
          <div
            style={{
              fontSize: '10px',
              color: 'var(--color-text-faint)',
              marginBottom: '6px',
            }}
          >
            工具调用 ({toolCalls.length})
          </div>
          {toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}

      {needsYou.filter((n) => !n.resolved).length > 0 && (
        <div
          style={{
            marginTop: '4px',
            paddingTop: '4px',
            borderTop: '1px dashed var(--color-border)',
          }}
        >
          <div
            style={{
              fontSize: '10px',
              color: 'var(--color-text-faint)',
              marginBottom: '6px',
            }}
          >
            待处理 ({needsYou.filter((n) => !n.resolved).length})
          </div>
          {needsYou
            .filter((n) => !n.resolved)
            .map((n) => (
              <NeedsYouCard
                key={n.id}
                item={n}
                onResolve={() => onResolveNeedsYou(n.id)}
              />
            ))}
        </div>
      )}
    </>
  );
}

// ============================================================================
// 子组件: AgentMessageItem — 单条 Agent 消息
// ============================================================================
interface AgentMessageItemProps {
  message: AgentMessage;
}

function AgentMessageItem({ message }: AgentMessageItemProps) {
  const isUser = message.type === 'output' && !message.agentName;

  // 消息类型 → 颜色
  const typeColor: Record<AgentMessageType, string> = {
    thinking: 'var(--color-text-muted)',
    working: 'var(--color-primary)',
    output: 'var(--color-text)',
    done: 'var(--color-success)',
    error: 'var(--color-error)',
    plan: 'var(--color-primary)',
    observation: 'var(--color-text-muted)',
    reflection: 'var(--color-warning)',
  };

  // 消息类型 → 标签
  const typeLabel: Record<AgentMessageType, string> = {
    thinking: '思考',
    working: '执行',
    output: '',
    done: '完成',
    error: '错误',
    plan: '规划',
    observation: '观察',
    reflection: '反思',
  };

  const time = new Date(message.timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return (
    <div className="flex items-start gap-2" data-testid="tdsf-agent-message">
      <div
        className="flex-shrink-0 flex items-center justify-center rounded-full font-bold mt-0.5"
        style={{
          width: '20px',
          height: '20px',
          background: isUser
            ? 'var(--color-primary)'
            : 'var(--color-success)',
          color: isUser ? '#fff' : 'var(--color-bg)',
          fontSize: '10px',
        }}
      >
        {isUser ? 'U' : message.agentName?.[0]?.toUpperCase() ?? 'A'}
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="flex items-start justify-between gap-2">
          <span style={{ color: typeColor[message.type] }}>
            {message.type !== 'output' && typeLabel[message.type] && (
              <span
                style={{
                  fontSize: '10px',
                  marginRight: '4px',
                  padding: '1px 4px',
                  background: `color-mix(in srgb, ${typeColor[message.type]} 15%, transparent)`,
                  borderRadius: '3px',
                  color: typeColor[message.type],
                }}
              >
                {typeLabel[message.type]}
              </span>
            )}
            {message.content}
            {message.type === 'thinking' && (
              <span
                className="caret"
                style={{
                  display: 'inline-block',
                  width: '6px',
                  height: '11px',
                  background: 'var(--color-primary)',
                  verticalAlign: 'middle',
                  marginLeft: '1px',
                  animation: 'caret-blink 1s step-end infinite',
                }}
              />
            )}
          </span>
          <span
            className="tabular-nums flex-shrink-0"
            style={{ color: 'var(--color-text-faint)', fontSize: '10px' }}
          >
            {time}
          </span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 子组件: ToolCallCard — 工具调用卡
// ============================================================================
interface ToolCallCardProps {
  toolCall: ToolCallItem;
}

function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusColor = TOOL_STATUS_COLOR[toolCall.status];
  const statusLabel = TOOL_STATUS_LABEL[toolCall.status];
  const time = new Date(toolCall.startedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  // 风险等级（来自 risk 工具）
  const riskLevel = toolCall.riskLevel;
  const riskColor: string = riskLevel ? RISK_COLOR[riskLevel] : 'var(--color-text-faint)';

  return (
    <div
      className="rounded-md p-2.5 mb-1.5"
      style={{
        background: 'var(--color-surface-active)',
        border: '1px solid rgba(91,140,255,0.12)',
      }}
      data-testid="tdsf-tool-call-card"
    >
      {/* 头部：工具名 + 状态 + 时间 */}
      <div className="flex items-center gap-2 mb-1.5">
        <span style={{ fontSize: '11px' }}>&#x2699;</span>
        <span
          className="font-semibold"
          style={{ color: 'var(--color-text)', fontSize: '11px' }}
        >
          {toolCall.toolName}
        </span>
        {riskLevel && (
          <span
            className="px-1.5 py-0.5 rounded font-medium"
            style={{
              background: `color-mix(in srgb, ${riskColor} 15%, transparent)`,
              color: riskColor,
              fontSize: '9px',
            }}
          >
            {riskLevel}
          </span>
        )}
        <span
          className="px-1.5 py-0.5 rounded font-medium"
          style={{
            background: `color-mix(in srgb, ${statusColor} 15%, transparent)`,
            color: statusColor,
            fontSize: '9px',
          }}
        >
          {statusLabel}
        </span>
        <div className="flex-1" />
        <span
          className="tabular-nums"
          style={{ color: 'var(--color-text-faint)', fontSize: '10px' }}
        >
          {time}
        </span>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-xs transition-colors"
          style={{
            color: 'var(--color-text-faint)',
            cursor: 'pointer',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
          }}
          title={expanded ? '折叠' : '展开'}
        >
          ▶
        </button>
      </div>

      {/* 展开内容：参数 + 结果 */}
      {expanded && (
        <div
          className="space-y-1.5"
          style={{ fontSize: '10px', fontFamily: 'var(--font-mono), monospace' }}
        >
          {Object.keys(toolCall.params).length > 0 && (
            <div>
              <div
                style={{
                  color: 'var(--color-text-faint)',
                  marginBottom: '2px',
                }}
              >
                参数:
              </div>
              <pre
                style={{
                  background: 'var(--color-bg)',
                  padding: '4px 6px',
                  borderRadius: '3px',
                  color: 'var(--color-text-muted)',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {JSON.stringify(toolCall.params, null, 2)}
              </pre>
            </div>
          )}
          {toolCall.result && (
            <div>
              <div
                style={{
                  color: 'var(--color-text-faint)',
                  marginBottom: '2px',
                }}
              >
                结果:
              </div>
              <pre
                style={{
                  background: 'var(--color-bg)',
                  padding: '4px 6px',
                  borderRadius: '3px',
                  color: 'var(--color-text-muted)',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}
          {toolCall.error && (
            <div>
              <div
                style={{
                  color: 'var(--color-error)',
                  marginBottom: '2px',
                }}
              >
                错误:
              </div>
              <pre
                style={{
                  background: 'rgba(248,113,113,0.05)',
                  padding: '4px 6px',
                  borderRadius: '3px',
                  color: 'var(--color-error)',
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {toolCall.error}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* 审批按钮（待审批状态） */}
      {toolCall.status === 'pending_approval' && (
        <div className="flex items-center gap-1.5 mt-1.5">
          <button
            className="px-3 py-1 rounded font-medium text-[11px] transition-colors"
            style={{
              background: 'var(--color-success)',
              color: 'var(--color-bg)',
              fontSize: '11px',
            }}
          >
            批准
          </button>
          <button
            className="px-3 py-1 rounded font-medium text-[11px] transition-colors"
            style={{
              border: '1px solid var(--color-border-strong)',
              color: 'var(--color-text-muted)',
              fontSize: '11px',
            }}
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 子组件: NeedsYouCard — needs-you 通知卡
// ============================================================================
interface NeedsYouCardProps {
  item: import('../store/runtime').NeedsYouItem;
  onResolve: () => void;
}

function NeedsYouCard({ item, onResolve }: NeedsYouCardProps) {
  const typeColor: Record<string, string> = {
    approval: 'var(--color-warning)',
    error: 'var(--color-error)',
    question: 'var(--color-primary)',
    handoff: 'var(--color-success)',
  };
  const typeLabel: Record<string, string> = {
    approval: '审批',
    error: '错误',
    question: '提问',
    handoff: '接管',
  };

  // P1-1 (2026-08-01): 审批按钮真实调用 needs_you.approve/reject RPC，
  // 后端唤醒等待中的工具线程 → 批准后命令真正执行。
  // 之前的实现两个按钮都只消除本地卡片（无 RPC 回传），审批是摆设。
  const respondApproval = useCallback(
    (approved: boolean) => {
      if (!item.reqId) {
        console.warn('[NeedsYouCard] 无 reqId，无法回传审批结果（旧事件格式）');
        onResolve();
        return;
      }
      void import('@/lib/sidecar-bridge')
        .then(({ invokeRpc }) =>
          approved
            ? invokeRpc('needs_you.approve', { req_id: item.reqId })
            : invokeRpc('needs_you.reject', { req_id: item.reqId, reason: '用户拒绝' }),
        )
        .then(() => onResolve())
        .catch((e) => {
          console.error('[NeedsYouCard] 审批回传失败:', e);
          // 回传失败仍消除卡片，避免卡片残留阻塞 UI
          onResolve();
        });
    },
    [item.reqId, onResolve],
  );

  return (
    <div
      className="rounded-md p-2.5 mb-1.5"
      style={{
        background: `color-mix(in srgb, ${typeColor[item.type]} 8%, var(--color-surface-active))`,
        border: `1px solid color-mix(in srgb, ${typeColor[item.type]} 30%, transparent)`,
      }}
      data-testid="tdsf-needs-you-card"
    >
      <div className="flex items-center gap-2 mb-1">
        <span
          className="px-1.5 py-0.5 rounded font-medium"
          style={{
            background: `color-mix(in srgb, ${typeColor[item.type]} 20%, transparent)`,
            color: typeColor[item.type],
            fontSize: '9px',
          }}
        >
          {typeLabel[item.type]}
        </span>
        <span
          className="font-semibold"
          style={{ color: 'var(--color-text)', fontSize: '11px' }}
        >
          {item.title}
        </span>
      </div>
      {item.detail && (
        <div
          style={{
            color: 'var(--color-text-muted)',
            fontSize: '10px',
            marginBottom: '6px',
          }}
        >
          {item.detail}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        {item.type === 'approval' && (
          <>
            <button
              onClick={() => respondApproval(true)}
              className="px-3 py-1 rounded font-medium text-[11px] transition-colors"
              style={{
                background: 'var(--color-success)',
                color: 'var(--color-bg)',
                fontSize: '11px',
              }}
            >
              批准
            </button>
            <button
              onClick={() => respondApproval(false)}
              className="px-3 py-1 rounded font-medium text-[11px] transition-colors"
              style={{
                border: '1px solid var(--color-border-strong)',
                color: 'var(--color-text-muted)',
                fontSize: '11px',
              }}
            >
              拒绝
            </button>
          </>
        )}
        {item.type === 'error' && (
          <>
            <button
              onClick={onResolve}
              className="px-3 py-1 rounded font-medium text-[11px] transition-colors"
              style={{
                background: 'var(--color-primary)',
                color: '#fff',
                fontSize: '11px',
              }}
            >
              重试
            </button>
            <button
              onClick={onResolve}
              className="px-3 py-1 rounded font-medium text-[11px] transition-colors"
              style={{
                color: 'var(--color-text-faint)',
                fontSize: '11px',
              }}
            >
              忽略
            </button>
          </>
        )}
        {item.type === 'question' && (
          <>
            <input
              type="text"
              placeholder="输入回答..."
              className="flex-1 px-2 py-1 rounded text-[11px]"
              style={{
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text)',
                fontSize: '11px',
              }}
            />
            <button
              onClick={onResolve}
              className="px-3 py-1 rounded font-medium text-[11px] transition-colors"
              style={{
                background: 'var(--color-primary)',
                color: '#fff',
                fontSize: '11px',
              }}
            >
              回答
            </button>
          </>
        )}
        {item.type === 'handoff' && (
          <button
            onClick={onResolve}
            className="px-3 py-1 rounded font-medium text-[11px] transition-colors"
            style={{
              background: 'var(--color-success)',
              color: 'var(--color-bg)',
              fontSize: '11px',
            }}
          >
            接管
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 子组件: SubAgentGrid — 9 子 Agent 状态卡片（T-P4-07）
// ============================================================================
interface SubAgentGridProps {
  agentStates: AgentStateItem[];
}

/** mood → 表情符号（用于 Agent 卡片显示） */
const AGENT_MOOD_FACE: Record<string, string> = {
  idle: '⬡',
  thinking: '◌',
  stream: '~',
  working: '○',
  waiting: '⏸',
  done: '✓',
  error: '✗',
};

/** mood → 颜色 */
const AGENT_MOOD_COLOR: Record<string, string> = {
  idle: 'var(--color-text-faint)',
  thinking: 'var(--color-primary)',
  stream: 'var(--color-primary)',
  working: 'var(--color-success)',
  waiting: 'var(--color-warning)',
  done: 'var(--color-success)',
  error: 'var(--color-error)',
};

function SubAgentGrid({ agentStates }: SubAgentGridProps) {
  return (
    <div
      data-testid="tdsf-sub-agent-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '4px',
        padding: '4px 0',
        marginBottom: '4px',
        borderBottom: '1px dashed var(--color-border)',
      }}
    >
      {agentStates.map((agent) => {
        const moodColor = AGENT_MOOD_COLOR[agent.mood] ?? AGENT_MOOD_COLOR.idle;
        const isActive = agent.active;
        return (
          <div
            key={agent.name}
            data-testid="tdsf-sub-agent-card"
            data-agent-name={agent.name}
            data-active={isActive ? 'true' : 'false'}
            title={`${agent.name} — ${agent.role}`}
            style={{
              padding: '4px 6px',
              background: isActive
                ? `color-mix(in srgb, ${moodColor} 10%, transparent)`
                : 'var(--color-surface-active)',
              border: `1px solid ${
                isActive
                  ? `color-mix(in srgb, ${moodColor} 40%, transparent)`
                  : 'var(--color-border)'
              }`,
              borderRadius: '4px',
              fontSize: '10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '1px',
              cursor: 'default',
              transition: 'all 0.15s',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '3px',
              }}
            >
              <span
                style={{
                  color: moodColor,
                  fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                  fontSize: '11px',
                }}
                data-testid="tdsf-sub-agent-mood"
              >
                {AGENT_MOOD_FACE[agent.mood] ?? '⬡'}
              </span>
              <span
                style={{
                  color: isActive
                    ? 'var(--color-text)'
                    : 'var(--color-text-muted)',
                  fontWeight: isActive ? 600 : 400,
                  fontSize: '10px',
                }}
              >
                {agent.name}
              </span>
              {agent.invocations > 0 && (
                <span
                  className="tabular-nums"
                  style={{
                    color: 'var(--color-text-faint)',
                    fontSize: '9px',
                    marginLeft: 'auto',
                  }}
                  data-testid="tdsf-sub-agent-invocations"
                >
                  ×{agent.invocations}
                </span>
              )}
            </div>
            <div
              style={{
                color: 'var(--color-text-faint)',
                fontSize: '9px',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {agent.lastTask || agent.role}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// 子组件: SteerInjectBar — 运行时指令注入输入框（T-P4-06）
// ============================================================================
interface SteerInjectBarProps {
  disabled: boolean;
}

function SteerInjectBar({ disabled }: SteerInjectBarProps) {
  const [steerText, setSteerText] = useState('');
  const [agentName, setAgentName] = useState('main');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  const handleSteerKeyDown = async (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    if (disabled || submitting || !steerText.trim()) return;

    setSubmitting(true);
    setFeedback(null);
    try {
      const running = await isRunning();
      if (!running) {
        // 浏览器预览模式：直接显示 mock 成功（不调用真实 sidecar）
        setFeedback({
          ok: true,
          msg: `[mock] steer 已注入 → ${agentName} (${priority})`,
        });
        setSteerText('');
        return;
      }
      const result = await invokeRpc<{ ok?: boolean; queued?: boolean }>(
        'tool.invoke',
        {
          name: 'steer_inject',
          params: {
            agent_name: agentName,
            instruction: steerText,
            session_id: '',
            priority,
          },
        },
      );
      if (result?.ok) {
        setFeedback({
          ok: true,
          msg: `steer 已注入 → ${agentName} (queue_size=${result.queued ? 1 : 0})`,
        });
        setSteerText('');
      } else {
        setFeedback({ ok: false, msg: 'steer 注入失败：未知响应' });
      }
    } catch (err) {
      const ipcErr = parseIPCError(err as unknown);
      setFeedback({ ok: false, msg: `steer 注入失败: ${ipcErr.message}` });
    } finally {
      setSubmitting(false);
      // 3 秒后清除反馈
      setTimeout(() => setFeedback(null), 3_000);
    }
  };

  return (
    <div
      data-testid="tdsf-steer-inject-bar"
      style={{
        padding: '4px 12px',
        borderTop: '1px dashed var(--color-border)',
        background: disabled
          ? 'var(--color-surface)'
          : 'color-mix(in srgb, var(--color-primary) 4%, var(--color-surface))',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          fontSize: '10px',
          color: 'var(--color-text-faint)',
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
            color: disabled ? 'var(--color-text-faint)' : 'var(--color-primary)',
          }}
        >
          steer&gt;
        </span>
        <span>运行时指令注入</span>
        {disabled && (
          <span style={{ color: 'var(--color-text-faint)' }}>
            （Agent 空闲，需执行中才能注入）
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <select
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          disabled={disabled || submitting}
          data-testid="tdsf-steer-inject-agent"
          style={{
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)',
            fontSize: '10px',
            padding: '2px 4px',
            borderRadius: '3px',
            fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          {SUB_AGENT_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={priority}
          onChange={(e) =>
            setPriority(e.target.value as 'low' | 'normal' | 'high')
          }
          disabled={disabled || submitting}
          data-testid="tdsf-steer-inject-priority"
          style={{
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            color:
              priority === 'high'
                ? 'var(--color-error)'
                : priority === 'low'
                  ? 'var(--color-text-faint)'
                  : 'var(--color-text-muted)',
            fontSize: '10px',
            padding: '2px 4px',
            borderRadius: '3px',
            fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          <option value="low">low</option>
          <option value="normal">normal</option>
          <option value="high">high</option>
        </select>
        <input
          type="text"
          value={steerText}
          onChange={(e) => setSteerText(e.target.value)}
          onKeyDown={(e) => void handleSteerKeyDown(e)}
          placeholder={
            disabled ? '等待 Agent 执行...' : '注入指令，如 "use type hints"'
          }
          disabled={disabled || submitting}
          data-testid="tdsf-steer-inject-input"
          maxLength={500}
          style={{
            flex: 1,
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text)',
            fontSize: '11px',
            padding: '3px 6px',
            borderRadius: '3px',
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
        {feedback && (
          <span
            data-testid="tdsf-steer-inject-feedback"
            style={{
              color: feedback.ok ? 'var(--color-success)' : 'var(--color-error)',
              fontSize: '10px',
              whiteSpace: 'nowrap',
            }}
          >
            {feedback.ok ? '✓' : '✗'} {feedback.msg}
          </span>
        )}
      </div>
    </div>
  );
}

/** 9 子 Agent 名列表（与 SUB_AGENT_DEFAULTS 对齐，供 SteerInjectBar 下拉使用） */
const SUB_AGENT_NAMES = [
  'main',
  'coding',
  'explore',
  'history',
  'teach',
  'debug',
  'refactor',
  'test',
  'deploy',
] as const;

// ============================================================================
// 子组件: KnowledgeCardItemView — 知识卡（T-P3-08）
// ============================================================================
interface KnowledgeCardItemViewProps {
  card: KnowledgeCardItem;
}

function KnowledgeCardItemView({ card }: KnowledgeCardItemViewProps) {
  const [expanded, setExpanded] = useState(false);

  // 来源 → 颜色（按 source 分类着色）
  const sourceColor: string = card.source.startsWith('nginx')
    ? 'var(--color-success)'
    : card.source.startsWith('docker')
      ? 'var(--color-primary)'
      : card.source.startsWith('user')
        ? 'var(--color-warning)'
        : 'var(--color-text-muted)';

  // 评分 → 百分比显示
  const scorePercent = Math.round(card.score * 100);

  return (
    <div
      className="rounded-md p-2.5 mb-1.5"
      style={{
        background: `color-mix(in srgb, ${sourceColor} 5%, var(--color-surface-active))`,
        border: `1px solid color-mix(in srgb, ${sourceColor} 25%, transparent)`,
      }}
      data-testid="tdsf-knowledge-card"
    >
      {/* 头部：来源标签 + 评分 + 展开 */}
      <div className="flex items-center gap-2 mb-1">
        <span
          className="px-1.5 py-0.5 rounded font-medium"
          style={{
            background: `color-mix(in srgb, ${sourceColor} 18%, transparent)`,
            color: sourceColor,
            fontSize: '9px',
          }}
        >
          {card.source || 'unknown'}
        </span>
        {card.matchType && (
          <span
            className="px-1 py-0.5 rounded"
            style={{
              color: 'var(--color-text-faint)',
              fontSize: '9px',
              border: '1px solid var(--color-border)',
            }}
          >
            {card.matchType === 'fts5' ? '关键词' : '语义'}
          </span>
        )}
        <div className="flex-1" />
        <span
          className="tabular-nums"
          style={{ color: 'var(--color-text-faint)', fontSize: '9px' }}
        >
          {scorePercent}%
        </span>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-xs transition-transform"
          style={{
            color: 'var(--color-text-faint)',
            cursor: 'pointer',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
          }}
          title={expanded ? '折叠' : '展开'}
        >
          ▶
        </button>
      </div>

      {/* 标题 */}
      <div
        className="font-semibold mb-1"
        style={{ color: 'var(--color-text)', fontSize: '11px' }}
      >
        {card.title || '(无标题)'}
      </div>

      {/* 摘要（展开时显示完整 snippet） */}
      <div
        style={{
          color: 'var(--color-text-muted)',
          fontSize: '10px',
          lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: expanded ? 'none' : 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {card.snippet || '(无内容)'}
      </div>

      {/* 展开时显示 URL */}
      {expanded && card.url && (
        <div
          style={{
            marginTop: '6px',
            paddingTop: '4px',
            borderTop: '1px dashed var(--color-border)',
            fontSize: '10px',
          }}
        >
          <a
            href={card.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: 'var(--color-primary)',
              textDecoration: 'none',
              wordBreak: 'break-all',
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.textDecoration = 'underline')
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.textDecoration = 'none')
            }
            data-testid="tdsf-knowledge-card-url"
          >
            {card.url}
          </a>
        </div>
      )}
    </div>
  );
}
