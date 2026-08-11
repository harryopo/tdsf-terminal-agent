// TDSF 魔改 (P2 SSH 隧道, 方案书 v1.1 §四): 新建隧道对话框
// -----------------------------------------------------------------------------
// 表单: 会话选择 + 名称 + 本地端口 + 远程主机 + 远程端口 + 本地地址(高级)。
// 仅列出已连接 (state === 'connected' 且 rustSessionId 非空) 的 SSH 会话。
// 提交走 tunnelStore.startTunnel → Rust tunnel_start 命令。

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSshStore, isSessionConnected } from "@/modules/ssh-explorer";
import { HugeiconsIcon } from "@hugeicons/react";
import { InformationCircleIcon, Router01Icon } from "@hugeicons/core-free-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useTunnelsStore } from "./lib/tunnelStore";
import {
  EMPTY_TUNNEL_FORM,
  isValidPort,
  isValidTunnelName,
  type TunnelFormData,
} from "./types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateTunnelDialog({ open, onOpenChange }: Props) {
  const sessions = useSshStore((s) => s.sessions);
  const busy = useTunnelsStore((s) => s.busy);
  const startTunnel = useTunnelsStore((s) => s.startTunnel);

  // 已连接会话（rustSessionId 非空才可建隧道）；useMemo 避免每次渲染重建数组
  const connectedSessions = useMemo(
    () => sessions.filter(isSessionConnected),
    [sessions],
  );

  const [form, setForm] = useState<TunnelFormData>(EMPTY_TUNNEL_FORM);
  const [submitting, setSubmitting] = useState(false);

  // 打开时重置表单 + 默认选中第一个已连接会话
  useEffect(() => {
    if (!open) return;
    setSubmitting(false);
    setForm((prev) => {
      const first = connectedSessions[0];
      if (!first || prev.sessionId !== 0) return prev;
      return {
        ...prev,
        sessionId: first.rustSessionId ?? 0,
        sessionLabel: `${first.params.user}@${first.params.host}`,
      };
    });
  }, [open, connectedSessions]);

  const setField = useCallback(<K extends keyof TunnelFormData>(
    key: K,
    value: TunnelFormData[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSessionChange = useCallback(
    (value: string) => {
      const id = Number(value);
      const sess = connectedSessions.find((s) => s.rustSessionId === id);
      setForm((prev) => ({
        ...prev,
        sessionId: id,
        sessionLabel: sess
          ? `${sess.params.user}@${sess.params.host}`
          : "",
      }));
    },
    [connectedSessions],
  );

  const handleSubmit = useCallback(async () => {
    // === 表单校验 ===
    if (form.sessionId === 0) {
      toast.error("请选择 SSH 会话");
      return;
    }
    if (!isValidTunnelName(form.name)) {
      toast.error("请输入隧道名称");
      return;
    }
    if (!isValidPort(form.localPort)) {
      toast.error("本地端口需为 1-65535 的整数");
      return;
    }
    if (form.remoteHost.trim().length === 0) {
      toast.error("请输入远程目标地址");
      return;
    }
    if (!isValidPort(form.remotePort)) {
      toast.error("远程端口需为 1-65535 的整数");
      return;
    }
    if (form.localHost.trim().length === 0) {
      toast.error("本地监听地址不能为空");
      return;
    }

    setSubmitting(true);
    const result = await startTunnel({
      name: form.name.trim(),
      sessionId: form.sessionId,
      localHost: form.localHost.trim(),
      localPort: Number(form.localPort),
      remoteHost: form.remoteHost.trim(),
      remotePort: Number(form.remotePort),
    });
    setSubmitting(false);

    if (result.ok) {
      toast.success(`隧道「${form.name.trim()}」已创建`);
      onOpenChange(false);
      setForm(EMPTY_TUNNEL_FORM);
    } else {
      toast.error(result.error ?? "创建隧道失败");
    }
  }, [form, startTunnel, onOpenChange]);

  const canSubmit =
    !busy &&
    !submitting &&
    form.sessionId !== 0 &&
    isValidTunnelName(form.name) &&
    isValidPort(form.localPort) &&
    form.remoteHost.trim().length > 0 &&
    isValidPort(form.remotePort);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={Router01Icon}
              size={16}
              strokeWidth={1.75}
              className="text-primary"
            />
            新建 SSH 隧道
          </DialogTitle>
          <DialogDescription>
            本地端口转发（direct-tcpip）：本地端口 → SSH 隧道 → 远程目标
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3.5 py-1">
          {/* === 会话选择 === */}
          <div className="grid gap-1.5">
            <Label htmlFor="tunnel-session" className="text-[11.5px]">
              SSH 会话
            </Label>
            <Select
              value={form.sessionId === 0 ? "" : String(form.sessionId)}
              onValueChange={handleSessionChange}
              disabled={connectedSessions.length === 0}
            >
              <SelectTrigger
                id="tunnel-session"
                data-testid="tunnel-session-select"
                className="w-full text-[12px]"
              >
                <SelectValue
                  placeholder={
                    connectedSessions.length === 0
                      ? "暂无已连接的 SSH 会话"
                      : "选择 SSH 会话"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {connectedSessions.map((sess) => (
                  <SelectItem
                    key={sess.id}
                    value={String(sess.rustSessionId)}
                    data-testid={`tunnel-session-${sess.params.host}`}
                  >
                    {sess.params.user}@{sess.params.host}:
                    {sess.params.port ?? 22}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* === 名称 === */}
          <div className="grid gap-1.5">
            <Label htmlFor="tunnel-name" className="text-[11.5px]">
              名称
            </Label>
            <Input
              id="tunnel-name"
              type="text"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder="如：远程数据库 5432"
              className="h-8 text-[12px]"
              data-testid="tunnel-name-input"
            />
          </div>

          {/* === 本地端口 + 远程目标端口 === */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="grid gap-1.5">
              <Label htmlFor="tunnel-local-port" className="text-[11.5px]">
                本地端口
              </Label>
              <Input
                id="tunnel-local-port"
                type="number"
                min={1}
                max={65535}
                value={form.localPort}
                onChange={(e) => setField("localPort", e.target.value)}
                placeholder="如：5432"
                className="h-8 text-[12px] tabular-nums"
                data-testid="tunnel-local-port-input"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tunnel-remote-port" className="text-[11.5px]">
                远程端口
              </Label>
              <Input
                id="tunnel-remote-port"
                type="number"
                min={1}
                max={65535}
                value={form.remotePort}
                onChange={(e) => setField("remotePort", e.target.value)}
                placeholder="如：5432"
                className="h-8 text-[12px] tabular-nums"
                data-testid="tunnel-remote-port-input"
              />
            </div>
          </div>

          {/* === 远程目标地址 === */}
          <div className="grid gap-1.5">
            <Label htmlFor="tunnel-remote-host" className="text-[11.5px]">
              远程目标地址
            </Label>
            <Input
              id="tunnel-remote-host"
              type="text"
              value={form.remoteHost}
              onChange={(e) => setField("remoteHost", e.target.value)}
              placeholder="如：db.internal.example.com（相对 SSH 服务器可达）"
              className="h-8 text-[12px]"
              data-testid="tunnel-remote-host-input"
            />
          </div>

          {/* === 本地监听地址（高级） === */}
          <div className="grid gap-1.5">
            <Label htmlFor="tunnel-local-host" className="text-[11.5px]">
              本地监听地址
            </Label>
            <Input
              id="tunnel-local-host"
              type="text"
              value={form.localHost}
              onChange={(e) => setField("localHost", e.target.value)}
              placeholder="127.0.0.1"
              className="h-8 text-[12px]"
              data-testid="tunnel-local-host-input"
            />
            <p className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
              <HugeiconsIcon
                icon={InformationCircleIcon}
                size={11}
                strokeWidth={1.75}
                className="shrink-0"
              />
              默认 127.0.0.1（仅本机访问）；填 0.0.0.0 可对外暴露，慎用
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy || submitting}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            data-testid="tunnel-create-submit"
          >
            {submitting || busy ? "创建中…" : "创建隧道"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
