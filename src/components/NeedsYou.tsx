/**
 * NeedsYou.tsx — needs-you 协调收件箱 (P1-B)
 * -----------------------------------------------------------------------------
 * v4.0 DEC-V321-07: 聚合 approvals / errors / user_questions / handoffs
 * 避免弹窗轰炸, 用户集中处理
 *
 * UI: 浮窗 (右下角), 数字徽章显示未处理数
 * 4 种类型不同 icon + 颜色
 */
import { useState, useEffect } from 'react';
import { Inbox, AlertCircle, HelpCircle, Handshake, Check, X, AlertTriangle } from 'lucide-react';
import { useRuntime, type NeedsYouType, type NeedsYouItem } from '../store/runtime';

const TYPE_META: Record<NeedsYouType, {
  icon: typeof Inbox;
  color: string;
  label: string;
}> = {
  approval: { icon: AlertCircle, color: 'var(--color-warning)', label: '审批' },
  error: { icon: AlertTriangle, color: 'var(--color-error)', label: '错误' },
  question: { icon: HelpCircle, color: 'var(--color-info)', label: '问题' },
  handoff: { icon: Handshake, color: 'var(--color-primary)', label: '交接' },
};

export function NeedsYou() {
  const { state, dispatch } = useRuntime();
  const [open, setOpen] = useState(false);

  // P1 阶段: 演示模式, 启动后添加 1 个 mock 需求
  useEffect(() => {
    if (state.needsYou.length > 0) return;
    const t = setTimeout(() => {
      dispatch({
        type: 'add-needs-you',
        item: {
          id: 't-ny-demo',
          type: 'approval',
          title: '需要批准: 重启 nginx',
          detail: '命令: sudo systemctl restart nginx\n风险等级: L3 (必须确认)',
        },
      });
    }, 3000);
    return () => clearTimeout(t);
  }, [state.needsYou.length, dispatch]);

  const pending = state.needsYou.filter((it) => !it.resolved);
  const resolved = state.needsYou.filter((it) => it.resolved);

  if (pending.length === 0 && !open) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-30 flex flex-col items-end gap-2">
      {/* === 列表面板 === */}
      {open && (
        <div
          className="w-80 max-h-96 flex flex-col rounded-lg shadow-panel animate-slide-up"
          style={{
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
          }}
        >
          <header
            className="flex items-center justify-between px-3 h-10 shrink-0"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            <div className="flex items-center gap-2">
              <Inbox className="w-3.5 h-3.5" style={{ color: 'var(--color-primary)' }} />
              <span className="text-xs font-mono font-semibold">needs-you</span>
              {pending.length > 0 && (
                <span
                  className="px-1.5 rounded-full text-[10px] font-bold"
                  style={{ background: 'var(--color-error)' }}
                >
                  {pending.length}
                </span>
              )}
            </div>
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded text-text-faint hover:text-foreground hover:bg-surface-hover interactive"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {pending.length === 0 && resolved.length === 0 && (
              <div className="text-center text-text-faint text-xs font-mono py-6">
                暂无事项
              </div>
            )}
            {pending.map((it) => (
              <Item key={it.id} item={it} dispatch={dispatch} />
            ))}
            {resolved.length > 0 && (
              <>
                <div className="text-[10px] text-text-faint font-mono pt-2 px-1">
                  已解决 ({resolved.length})
                </div>
                {resolved.slice(0, 3).map((it) => (
                  <Item key={it.id} item={it} dispatch={dispatch} disabled />
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* === 触发按钮 === */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-xs font-mono shadow-panel interactive"
        style={{
          background: pending.length > 0 ? 'var(--color-error)' : 'var(--color-surface)',
          color: pending.length > 0 ? 'var(--color-text-on-primary)' : 'var(--color-text)',
          border: '1px solid var(--color-border)',
        }}
      >
        <Inbox className="w-3.5 h-3.5" />
        needs-you
        {pending.length > 0 && (
          <span
            className="px-1.5 rounded-full text-[10px] font-bold"
            style={{
              background: pending.length > 0 ? 'rgba(255,255,255,0.25)' : 'var(--color-primary)',
            }}
          >
            {pending.length}
          </span>
        )}
      </button>
    </div>
  );
}

function Item({ item, dispatch, disabled = false }: {
  item: NeedsYouItem;
  dispatch: ReturnType<typeof useRuntime>['dispatch'];
  disabled?: boolean;
}) {
  const meta = TYPE_META[item.type];
  const Icon = meta.icon;
  return (
    <div
      className={`
        p-2 rounded-md text-xs font-mono space-y-1
        ${disabled ? 'opacity-50' : ''}
      `}
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
      }}
    >
      <div className="flex items-center gap-2">
        <Icon className="w-3 h-3 shrink-0" style={{ color: meta.color }} />
        <span className="font-semibold flex-1 truncate">{item.title}</span>
        {!disabled && (
          <button
            onClick={() => dispatch({ type: 'resolve-needs-you', id: item.id })}
            className="p-0.5 rounded text-text-faint hover:text-success interactive"
            title="标记为已解决"
          >
            <Check className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className="text-text-faint text-[10px] whitespace-pre-wrap pl-5">
        {item.detail}
      </div>
      <div className="text-text-faint text-[10px] pl-5">
        {new Date(item.createdAt).toLocaleTimeString()}
      </div>
    </div>
  );
}
