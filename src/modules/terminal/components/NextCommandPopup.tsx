/**
 * “下一步建议”弹窗（2026-11-12）
 * -----------------------------------------------------------------------------
 * 与 TerminalCompletionPopup（逐键预测补全）分开：只在用户显式按
 * Ctrl+Shift+Space（备用 Ctrl+Alt+Space）后出现，复用同一套黑白灰候选样式。
 * 接受只填入当前空行，不追加换行、不执行。
 */
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import type { Candidate } from '@/modules/prediction/contracts';
import {
  acceptNextCommand,
  closeNextCommand,
  getNextCommandState,
  subscribeNextCommand,
  type NextCommandState,
} from '@/modules/terminal/lib/nextCommandInjection';

const SOURCE_LABELS: Record<Candidate['source'], string> = {
  markov: '后续',
  mfc: '常用',
  mru: '最近',
  decay: '近期',
  cwd: '目录',
  dictionary: '词典',
  spec: '规格',
  model: '模型',
};

export function NextCommandPopup() {
  const [state, setState] = useState<NextCommandState>(() =>
    getNextCommandState(),
  );

  useEffect(() => subscribeNextCommand(setState), []);

  if (!state.visible) return null;

  return (
    <div
      data-no-drag
      data-testid="next-command-popup"
      className={cn(
        'fixed bottom-12 left-1/2 z-50 mb-2 max-h-72 w-96 -translate-x-1/2 overflow-auto rounded-lg border border-border bg-popover/95 shadow-2xl backdrop-blur-md',
        'animate-in fade-in-0 zoom-in-95 duration-150',
      )}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1 text-[10px] text-muted-foreground">
        <span className={state.task === 'correct' ? 'text-amber-500' : 'text-sky-500'}>
          ●
        </span>
        <span>
          {state.source === 'block'
            ? '刚才的命令可能拼错了'
            : state.task === 'correct'
              ? '当前行纠错'
              : '下一步建议'}
        </span>
        <span className="ml-auto">
          {state.source === 'block'
            ? 'Enter/→ 填入修正后的命令'
            : state.task === 'correct'
              ? state.auto
                ? '自动检测到拼写 · Enter/→ 填入'
                : 'Ctrl+Shift+. / Ctrl+Alt+. 触发 · Enter/→ 填入'
              : 'Ctrl+Shift+Space / Ctrl+Alt+Space 触发 · Enter/→ 填入'}
        </span>
      </div>

      {state.loading ? (
        <div className="px-3 py-3 text-[12px] text-muted-foreground">
          正在计算…
        </div>
      ) : null}

      {!state.loading && state.messageZh ? (
        <div className="px-3 py-3 text-[12px] leading-relaxed text-muted-foreground">
          {state.messageZh}
        </div>
      ) : null}

      {!state.loading &&
        state.candidates.map((candidate, index) => {
          const selected = index === state.selectedIndex;
          return (
            <button
              key={candidate.candidateId}
              type="button"
              data-testid="next-command-candidate"
              onClick={(event) => {
                event.stopPropagation();
                acceptNextCommand(index);
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left',
                selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              )}
            >
              <span className="shrink-0 font-mono text-[12px] font-medium text-foreground">
                {candidate.displayText}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground"
                title={candidate.summaryZh}
              >
                {candidate.summaryZh}
              </span>
              <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">
                {SOURCE_LABELS[candidate.source]}
              </span>
              <span className="shrink-0 text-[9px] text-emerald-600">
                {candidate.risk}
              </span>
            </button>
          );
        })}

      {state.visible && !state.loading ? (
        <div className="flex items-center border-t border-border/60 px-3 py-1 text-[10px] text-muted-foreground">
          <span>
            {state.source === 'block'
              ? '只填回提示符，不执行'
              : '只填入当前行，不执行'}
          </span>
          <button
            type="button"
            className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              closeNextCommand();
            }}
          >
            关闭
          </button>
        </div>
      ) : null}
    </div>
  );
}
