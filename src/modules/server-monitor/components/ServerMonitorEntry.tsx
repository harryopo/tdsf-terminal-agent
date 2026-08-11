// TDSF 服务器实时监控 —— 全局入口（浮动按钮 + 浮动面板）
// -----------------------------------------------------------------------------
// 在 App.tsx 顶层挂载。展示一个右上角的仪表盘图标按钮，点击后展开浮动监控面板。
// 面板定位：fixed right-3 top-12，不遮挡右下角的 AiMiniWindow。

import { DashboardSquare01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import { selectActiveSession, useSshStore, isSessionConnected } from '@/modules/ssh-explorer/sshStore';

import { ServerMonitorPanel } from './ServerMonitorPanel';

/** 服务器监控全局入口 */
export function ServerMonitorEntry() {
  const [open, setOpen] = useState(false);

  // 只在有 SSH 会话时显示按钮
  const activeSession = useSshStore(selectActiveSession);
  const hasConnectedSession = activeSession ? isSessionConnected(activeSession) : false;

  if (!hasConnectedSession) return null;

  return (
    <>
      {/* 开关按钮（固定在右上角，Header 下方） */}
      <button
        data-no-drag
        onClick={() => setOpen((v) => !v)}
        title={open ? '关闭服务器监控' : '打开服务器监控'}
        className={cn(
          'fixed right-3 top-12 z-50 flex size-8 items-center justify-center',
          'rounded-lg border border-border/60 bg-card/90 backdrop-blur-md',
          'shadow-lg transition-all duration-200',
          'hover:bg-accent hover:shadow-xl',
          open && 'text-primary',
          !open && 'text-muted-foreground',
        )}
      >
        <HugeiconsIcon icon={DashboardSquare01Icon} size={16} strokeWidth={1.75} />
      </button>

      {/* 浮动面板 */}
      {open && <ServerMonitorPanel onClose={() => setOpen(false)} />}
    </>
  );
}
