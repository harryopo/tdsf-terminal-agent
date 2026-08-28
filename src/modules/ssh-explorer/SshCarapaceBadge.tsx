/**
 * SshCarapaceBadge.tsx — SSH 终端远端动态补全提示（无弹窗设计，TDSF 2026-08-28）
 * -----------------------------------------------------------------------------
 * spec: .trae/specs/add-carapace-param-completion（远端安装链路 P1）。
 *
 * 设计要点（用户反感弹窗）：
 *   - 不弹 Toast、不打断连接流程——只在 SSH 终端右下角显示一个 16px 小图标
 *     （仅当远端未装 carapace 且 preferences 开关开启时出现）
 *   - 点击图标弹 Popover（Radix，项目已有基建）：检测状态 + 「安装」按钮
 *     （进度文案：准备/上传中/配置中/完成）+ 「不再提示」链接
 *   - 「不再提示」写入持久化 preferences（sshRemoteCarapacePrompt=false），
 *     所有会话不再显示、也不再发起静默检测
 *
 * 显隐条件三合一（任一不满足即不渲染，SSH leaf 无额外渲染开销）：
 *   1. 会话已连接（rustSessionId 可用）
 *   2. sshStore.remoteCarapaceBySession[sessionId] === 'missing'（静默检测完成）
 *   3. preferences.sshRemoteCarapacePrompt === true
 */
import { useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { SparklesIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  installRemoteCarapace,
  type CarapaceInstallStage,
} from '@/lib/param-complete-client';
// setter 在 settings/store（与 setLspActivation 同位）；响应式状态在 settings/preferences
import { setSshRemoteCarapacePrompt } from '@/modules/settings/store';
import { usePreferencesStore } from '@/modules/settings/preferences';
import { useSshStore } from './sshStore';

/** 安装阶段 → 中文进度文案（Popover 内展示） */
const STAGE_LABEL: Record<CarapaceInstallStage, string> = {
  preparing: '准备中…',
  uploading: '上传中…',
  configuring: '配置中…',
  done: '完成，已启用远端动态补全',
};

type Props = {
  /** SSH 会话前端 UUID（sshStore.sessions[].id） */
  sessionId: string;
};

export function SshCarapaceBadge({ sessionId }: Props) {
  // 值类型 selector（rustSessionId: number | null）——不返回新引用，符合红线 6
  const rustSessionId = useSshStore(
    (s) => s.sessions.find((it) => it.id === sessionId)?.rustSessionId ?? null,
  );
  const carapaceState = useSshStore((s) => s.remoteCarapaceBySession[sessionId]);
  const promptEnabled = usePreferencesStore((s) => s.sshRemoteCarapacePrompt);

  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<CarapaceInstallStage | 'error' | null>(null);
  const [installing, setInstalling] = useState(false);

  // 未连接 / 已安装 / 检测未完成 / 用户已永久关闭 → 不渲染（无任何占位）
  if (rustSessionId === null || carapaceState !== 'missing' || !promptEnabled) {
    return null;
  }

  const handleInstall = () => {
    if (installing || rustSessionId === null) return;
    setInstalling(true);
    setStage('preparing');
    void installRemoteCarapace(rustSessionId, setStage).then((ok) => {
      setInstalling(false);
      if (ok) {
        // 安装成功 → 更新 store 状态，badge 随显隐条件消失
        useSshStore.getState().setRemoteCarapaceState(sessionId, 'installed');
        setTimeout(() => setOpen(false), 1200);
      } else {
        setStage('error');
      }
    });
  };

  const handleDismiss = () => {
    // 持久化关闭：所有会话不再显示图标、不再静默检测
    void setSshRemoteCarapacePrompt(false);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="启用远端动态补全"
          className="absolute bottom-2 right-2 z-10 grid size-6 place-items-center rounded-full border border-border/50 bg-background/80 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-accent hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-64 p-3 text-xs [&_button]:cursor-pointer"
      >
        <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
          <HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={2} />
          远端动态补全
        </div>
        {stage === 'error' ? (
          <p className="mb-2 text-destructive">安装失败，请检查网络或稍后重试。</p>
        ) : stage !== null ? (
          <p className="mb-2 text-muted-foreground">{STAGE_LABEL[stage]}</p>
        ) : (
          <p className="mb-2 text-muted-foreground">
            远端服务器未安装 carapace。安装后可在参数位置补全远端真实环境的动态值
            （如 git 分支、目录、进程 PID）。
          </p>
        )}
        <div className="flex items-center gap-1.5">
          {stage === null || stage === 'error' ? (
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleInstall}
            >
              {stage === 'error' ? '重试安装' : '安装'}
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-md px-1.5 py-1 text-[11px] text-muted-foreground/70 hover:text-foreground"
            onClick={handleDismiss}
          >
            不再提示
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
