import { useSshStore } from "./sshStore";

export function SshFileIdentity({ sessionId }: { sessionId: number }) {
  const identity = useSshStore((s) => {
    const session = s.sessions.find((item) => item.rustSessionId === sessionId);
    return session ? `${session.params.user}@${session.params.host}` : null;
  });
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border/40 px-3 text-[11px] text-muted-foreground"
      title="文件操作保持原 SSH 认证身份，不随终端内 su 或嵌套 SSH 切换。">
      <span className="shrink-0">文件连接</span>
      <span className="truncate font-mono text-foreground/80">{identity ?? "原 SSH 认证身份"}</span>
    </div>
  );
}
