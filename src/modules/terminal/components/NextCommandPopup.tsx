/**
 * 下一步建议 / 命令纠错弹窗（2026-11-19 精简版）
 * -----------------------------------------------------------------------------
 * 视觉回到初版的克制风格：单张紧凑卡片、黑白灰底、彩色只用于状态点与风险字。
 * 交互按用户反馈收敛：默认只显示最优先的一条，按 ↓ 展开全部；已在展开态时
 * ↓↑ 移动选中，↑ 在首项时收起。接受只填入当前输入行，不追加换行、不执行。
 */
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import type { Candidate } from '@/modules/prediction/contracts';
import {
  acceptNextCommand,
  closeNextCommand,
  getNextCommandState,
  requestMoreCorrection,
  subscribeNextCommand,
  toggleNextCommandExpanded,
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

function riskClass(risk: Candidate['risk']): string {
  if (risk === 'L0' || risk === 'L1') return 'text-emerald-500';
  if (risk === 'L2') return 'text-amber-400';
  return 'text-muted-foreground';
}

function riskTitle(risk: Candidate['risk']): string {
  if (risk === 'L2') return '中风险：需要你确认后再执行';
  if (risk === 'L0' || risk === 'L1') return '低风险';
  return '风险未知';
}

export function NextCommandPopup() {
  const [state, setState] = useState<NextCommandState>(() =>
    getNextCommandState(),
  );

  useEffect(() => subscribeNextCommand(setState), []);

  if (!state.visible) return null;

  const correction = state.task === 'correct';
  const fromBlock = correction && state.source === 'block';
  const originalLine = state.correctionRequest?.buffer?.text ?? '';
  const title = fromBlock
    ? '上一条命令未找到'
    : correction
      ? state.auto
        ? '检测到命令名拼写异常'
        : '当前行纠错'
      : '下一步建议';
  const canExpand = state.candidates.length > 1;
  // 收起态只渲染最优先的一条：DOM 与视觉都只保留一个候选。
  const shown = state.expanded
    ? state.candidates
    : state.candidates.slice(0, 1);

  return (
    <div
      data-no-drag
      data-testid="next-command-popup"
      className={cn(
        'fixed bottom-12 left-1/2 z-50 mb-2 w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover/95 shadow-2xl backdrop-blur-md',
        'animate-in fade-in-0 zoom-in-95 duration-150',
      )}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">
        <span className={correction ? 'text-amber-500' : 'text-sky-500'}>
          ●
        </span>
        <span className="truncate text-[11.5px] font-medium text-foreground/90">
          {title}
        </span>
        {state.candidates.length > 0 ? (
          <span className="shrink-0 rounded-full border border-border/60 px-1.5 text-[9px]">
            {state.candidates.length} 条建议
          </span>
        ) : null}
        {correction ? (
          <button
            type="button"
            data-testid="next-command-more"
            title="用有界二次编辑（距离≤2）查找更宽的相近词形；仅回填，不执行"
            className="shrink-0 rounded px-1 text-[9.5px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              void requestMoreCorrection();
            }}
          >
            更多词形
          </button>
        ) : null}
        {canExpand ? (
          <button
            type="button"
            data-testid="next-command-expand-toggle"
            className="ml-auto shrink-0 rounded px-1 text-[9.5px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              toggleNextCommandExpanded();
            }}
          >
            {state.expanded ? '收起 ↑' : '展开 ↓'}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="关闭"
          className={cn(
            'shrink-0 rounded px-1 text-[13px] leading-none text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground',
            canExpand ? '' : 'ml-auto',
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            closeNextCommand();
          }}
        >
          ×
        </button>
      </div>

      {originalLine ? (
        <div className="flex items-baseline gap-2 border-b border-border/40 px-3 py-1.5">
          <span className="shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground/60">
            原命令
          </span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {originalLine}
          </span>
        </div>
      ) : null}

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

      {!state.loading && shown.length > 0 ? (
        <div
          className={cn(
            'py-1',
            state.expanded && 'max-h-64 overflow-auto',
          )}
        >
          {shown.map((candidate, index) => {
            const selected = index === state.selectedIndex;
            return (
              <button
                key={candidate.candidateId}
                type="button"
                data-testid="next-command-candidate"
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  acceptNextCommand(index);
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
                  selected
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/50',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12px] font-medium text-foreground">
                    {candidate.displayText}
                  </span>
                  <span
                    className="block truncate text-[10px] text-muted-foreground"
                    title={candidate.summaryZh}
                  >
                    {candidate.summaryZh}
                  </span>
                </span>
                <span className="shrink-0 text-[9px] text-muted-foreground">
                  {SOURCE_LABELS[candidate.source]}
                </span>
                <span
                  title={riskTitle(candidate.risk)}
                  className={cn(
                    'shrink-0 text-[9px] font-medium',
                    riskClass(candidate.risk),
                  )}
                >
                  {candidate.risk}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {!state.loading ? (
        <div className="flex items-center gap-2 border-t border-border/60 px-3 py-1 text-[9.5px] text-muted-foreground">
          {state.candidates.length === 0 ? (
            <>
              <span>Esc 关闭</span>
              <span className="ml-auto shrink-0">未修改输入行</span>
            </>
          ) : (
            <>
              {state.expanded ? (
                <span>↑↓ 选择</span>
              ) : canExpand ? (
                <span>↓ 展开</span>
              ) : null}
              <span>Enter / → 回填</span>
              <span>Esc 关闭</span>
              <span className="ml-auto shrink-0 font-medium text-amber-400/90">
                仅回填，不执行
              </span>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
