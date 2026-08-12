// TDSF 魔改 (P2 SSH 隧道 / P3 #24 三模式, 方案书 v1.1 §四): 新建隧道对话框
// -----------------------------------------------------------------------------
// 表单: 会话选择 + 名称 + 类型选择 + 按类型条件渲染字段:
//   - local  本地转发: 本地监听地址/端口 + 远程目标地址/端口
//   - remote 远程转发: 服务器监听地址/端口 + 本地目标地址/端口
//   - socks5 SOCKS5:  本地监听地址/端口
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
  TUNNEL_TYPE_META,
  type TunnelFormData,
  type TunnelKind,
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

  // 切换类型时清空旧类型字段残留，避免误提交
  const handleKindChange = useCallback((value: string) => {
    const kind = value as TunnelKind;
    setForm((prev) => ({
      ...prev,
      kind,
      localPort: "",
      remoteHost: "",
      remotePort: "",
      bindPort: "",
      localTargetHost: kind === "remote" ? prev.localTargetHost : "127.0.0.1",
      localTargetPort: "",
    }));
  }, []);

  /** 按类型校验必填字段，返回错误文案（null=通过） */
  const validateKindFields = useCallback(
    (f: TunnelFormData): string | null => {
      if (f.kind === "remote") {
        if (f.bindAddress.trim().length === 0) {
          return "服务器监听地址不能为空";
        }
        // bindPort 可留空 = 服务器自动分配；填写则必须是合法端口
        if (f.bindPort.trim().length > 0 && !isValidPort(f.bindPort)) {
          return "服务器端口需为 1-65535 的整数（留空=自动分配）";
        }
        if (f.localTargetHost.trim().length === 0) {
          return "请输入本地目标地址";
        }
        if (!isValidPort(f.localTargetPort)) {
          return "本地目标端口需为 1-65535 的整数";
        }
        return null;
      }
      // local / socks5 共用：本地监听
      if (f.localHost.trim().length === 0) {
        return "本地监听地址不能为空";
      }
      if (!isValidPort(f.localPort)) {
        return "本地端口需为 1-65535 的整数";
      }
      if (f.kind === "local") {
        if (f.remoteHost.trim().length === 0) {
          return "请输入远程目标地址";
        }
        if (!isValidPort(f.remotePort)) {
          return "远程端口需为 1-65535 的整数";
        }
      }
      return null;
    },
    [],
  );

  const handleSubmit = useCallback(async () => {
    // === 通用校验 ===
    if (form.sessionId === 0) {
      toast.error("请选择 SSH 会话");
      return;
    }
    if (!isValidTunnelName(form.name)) {
      toast.error("请输入隧道名称");
      return;
    }
    const kindError = validateKindFields(form);
    if (kindError) {
      toast.error(kindError);
      return;
    }

    setSubmitting(true);
    const spec =
      form.kind === "remote"
        ? {
            name: form.name.trim(),
            sessionId: form.sessionId,
            kind: "remote" as const,
            bindAddress: form.bindAddress.trim(),
            bindPort: form.bindPort.trim().length > 0 ? Number(form.bindPort) : undefined,
            localTargetHost: form.localTargetHost.trim(),
            localTargetPort: Number(form.localTargetPort),
          }
        : form.kind === "socks5"
          ? {
              name: form.name.trim(),
              sessionId: form.sessionId,
              kind: "socks5" as const,
              localHost: form.localHost.trim(),
              localPort: Number(form.localPort),
            }
          : {
              name: form.name.trim(),
              sessionId: form.sessionId,
              kind: "local" as const,
              localHost: form.localHost.trim(),
              localPort: Number(form.localPort),
              remoteHost: form.remoteHost.trim(),
              remotePort: Number(form.remotePort),
            };

    const result = await startTunnel(spec);
    setSubmitting(false);

    if (result.ok) {
      toast.success(`隧道「${form.name.trim()}」已创建`);
      onOpenChange(false);
      setForm(EMPTY_TUNNEL_FORM);
    } else {
      toast.error(result.error ?? "创建隧道失败");
    }
  }, [form, startTunnel, onOpenChange, validateKindFields]);

  const canSubmit =
    !busy &&
    !submitting &&
    form.sessionId !== 0 &&
    isValidTunnelName(form.name) &&
    validateKindFields(form) === null;

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
            {TUNNEL_TYPE_META[form.kind].hint}
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

          {/* === 隧道类型（P3 #24） === */}
          <div className="grid gap-1.5">
            <Label htmlFor="tunnel-kind" className="text-[11.5px]">
              类型
            </Label>
            <Select
              value={form.kind}
              onValueChange={handleKindChange}
            >
              <SelectTrigger
                id="tunnel-kind"
                data-testid="tunnel-kind-select"
                className="w-full text-[12px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TUNNEL_TYPE_META) as TunnelKind[]).map((k) => (
                  <SelectItem key={k} value={k} data-testid={`tunnel-kind-${k}`}>
                    {TUNNEL_TYPE_META[k].label}
                    <span className="ml-1.5 text-[10.5px] text-muted-foreground">
                      {TUNNEL_TYPE_META[k].hint}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* === 本地转发（-L）：本地监听 + 远程目标 === */}
          {form.kind === "local" && (
            <>
              {/* 本地端口 + 远程目标端口 */}
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

              {/* 远程目标地址 */}
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
            </>
          )}

          {/* === 远程转发（-R）：服务器监听 + 本地目标 === */}
          {form.kind === "remote" && (
            <>
              {/* 服务器监听端口（可选）+ 本地目标端口 */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="grid gap-1.5">
                  <Label htmlFor="tunnel-bind-port" className="text-[11.5px]">
                    服务器端口
                  </Label>
                  <Input
                    id="tunnel-bind-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.bindPort}
                    onChange={(e) => setField("bindPort", e.target.value)}
                    placeholder="留空=自动分配"
                    className="h-8 text-[12px] tabular-nums"
                    data-testid="tunnel-bind-port-input"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="tunnel-target-port" className="text-[11.5px]">
                    本地目标端口
                  </Label>
                  <Input
                    id="tunnel-target-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={form.localTargetPort}
                    onChange={(e) => setField("localTargetPort", e.target.value)}
                    placeholder="如：3000"
                    className="h-8 text-[12px] tabular-nums"
                    data-testid="tunnel-target-port-input"
                  />
                </div>
              </div>

              {/* 本地目标地址 */}
              <div className="grid gap-1.5">
                <Label htmlFor="tunnel-target-host" className="text-[11.5px]">
                  本地目标地址
                </Label>
                <Input
                  id="tunnel-target-host"
                  type="text"
                  value={form.localTargetHost}
                  onChange={(e) => setField("localTargetHost", e.target.value)}
                  placeholder="如：127.0.0.1（相对本机可达的服务）"
                  className="h-8 text-[12px]"
                  data-testid="tunnel-target-host-input"
                />
              </div>

              {/* 服务器监听地址 */}
              <div className="grid gap-1.5">
                <Label htmlFor="tunnel-bind-address" className="text-[11.5px]">
                  服务器监听地址
                </Label>
                <Input
                  id="tunnel-bind-address"
                  type="text"
                  value={form.bindAddress}
                  onChange={(e) => setField("bindAddress", e.target.value)}
                  placeholder="127.0.0.1"
                  className="h-8 text-[12px]"
                  data-testid="tunnel-bind-address-input"
                />
                <p className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
                  <HugeiconsIcon
                    icon={InformationCircleIcon}
                    size={11}
                    strokeWidth={1.75}
                    className="shrink-0"
                  />
                  默认 127.0.0.1；对外暴露受服务器 sshd GatewayPorts 配置约束
                </p>
              </div>
            </>
          )}

          {/* === SOCKS5（-D）：仅本地监听 === */}
          {form.kind === "socks5" && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="tunnel-local-port" className="text-[11.5px]">
                  本地监听端口
                </Label>
                <Input
                  id="tunnel-local-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={form.localPort}
                  onChange={(e) => setField("localPort", e.target.value)}
                  placeholder="如：1080"
                  className="h-8 text-[12px] tabular-nums"
                  data-testid="tunnel-local-port-input"
                />
              </div>
            </>
          )}

          {/* === 本地监听地址（Local/Socks5 用，高级） === */}
          {form.kind !== "remote" && (
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
          )}
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
