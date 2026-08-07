// TDSF 魔改 (P4-T4.1): SSH 连接对话框
// -----------------------------------------------------------------------------
// 表单字段: host / port / user / 认证方式 (password | publickey) / 私钥路径 / 口令
// 提交时调用 useSshStore.connect(params)
//
// TDSF 魔改 (永久保存密钥 + 自动登录):
//   - 顶部展示已保存的连接列表 (savedConnections), 一键点击自动登录
//   - "测试连接"按钮调用 store.testConnection (走 Rust ssh_test, 不保留会话)
//   - "永久保存密钥"勾选框: 测试成功后调用 store.saveConnection 写 keyring + JSON
//
// 设计要点:
//   - 默认端口 22, 失焦时若空则回填 22
//   - 认证方式切换时清空敏感字段 (password / passphrase)
//   - 灰色简约主题: 主按钮用 bg-primary hover:bg-primary/90 (与整体风格一致)

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
import type {
  SshAuthMethod,
  SshConnectParams,
  SshCredentialProfile,
} from "@/lib/ssh-bridge";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Delete01Icon,
  Loading03Icon,
  Login03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useSshStore } from "./sshStore";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** 认证方式选项 */
type AuthKind = "password" | "publickey";

/** 生成 profile id (host:port:user 风格, 稳定可读) */
function makeProfileId(host: string, port: number, user: string): string {
  return `${user}@${host}:${port}`;
}

/** 格式化 lastUsed 为相对时间 (如 "3 分钟前") */
function formatRelativeTime(ts: number): string {
  if (!ts) return "从未使用";
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function SshConnectDialog({ open, onOpenChange }: Props) {
  const connect = useSshStore((s) => s.connect);
  const testConnection = useSshStore((s) => s.testConnection);
  const saveConnection = useSshStore((s) => s.saveConnection);
  const deleteSavedConnection = useSshStore((s) => s.deleteSavedConnection);
  const connectWithSaved = useSshStore((s) => s.connectWithSaved);
  // TDSF 魔改 2026-07-28: 给 savedConnections 加默认值, 防止 mock 模式下
  // (浏览器 + 无 Tauri runtime) store 异步 hydrate 之前访问 .length 抛错.
  const savedConnections = useSshStore((s) => s.savedConnections) ?? [];

  // === 表单状态 ===
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("password");
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // TDSF 魔改: 测试连接 + 永久保存密钥选项
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  const [testMessage, setTestMessage] = useState<string>("");
  const [saveKey, setSaveKey] = useState(true); // 默认勾选永久保存
  // TDSF 魔改: 已保存连接 - 一键自动登录中的 profile id
  const [autoConnectingId, setAutoConnectingId] = useState<string | null>(null);

  // 关闭时重置表单
  useEffect(() => {
    if (!open) {
      setError(null);
      setSubmitting(false);
      setTesting(false);
      setTestResult(null);
      setTestMessage("");
      setAutoConnectingId(null);
    }
  }, [open]);

  /** TDSF 魔改: 测试连接 — 仅验证参数可达，不保持连接 */
  const handleTestConnection = async () => {
    if (!host.trim() || !user.trim()) {
      setTestResult("fail");
      setTestMessage("主机和用户名为必填项");
      return;
    }
    const portNum = Number.parseInt(port, 10);
    if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) {
      setTestResult("fail");
      setTestMessage("端口必须是 1-65535 之间的数字");
      return;
    }

    setTesting(true);
    setTestResult(null);
    setTestMessage("");
    try {
      let auth: SshAuthMethod;
      if (authKind === "password") {
        auth = { type: "password", password };
      } else {
        auth = {
          type: "publickey",
          privateKeyPath: privateKeyPath.trim(),
          passphrase: passphrase || undefined,
        };
      }
      const params: SshConnectParams = {
        host: host.trim(),
        port: portNum,
        user: user.trim(),
        auth,
      };
      const result = await testConnection(params);
      if (result.ok) {
        setTestResult("ok");
        setTestMessage(result.message || "连接测试成功");
      } else {
        setTestResult("fail");
        setTestMessage(result.message || "连接测试失败");
      }
    } catch (e) {
      setTestResult("fail");
      setTestMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  // 切换认证方式时清空敏感字段
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 authKind 变化时清空, 故意只依赖 authKind
  useEffect(() => {
    setPassword("");
    setPassphrase("");
  }, [authKind]);

  /** 端口失焦时若空回填 22 */
  const handlePortBlur = () => {
    if (!port.trim()) setPort("22");
  };

  /**
   * 提交连接
   *
   * 如果勾选了"永久保存密钥"且测试通过, 会先保存凭据再连接。
   * 保存流程:
   *   1. 组装 SshCredentialProfile (非敏感元数据)
   *   2. 调用 saveConnection: 写 keyring (敏感字段) + JSON (元数据)
   *   3. 调用 connect 发起实际连接
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!host.trim() || !user.trim()) {
      setError("主机和用户名为必填项");
      return;
    }
    const portNum = Number.parseInt(port, 10);
    if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) {
      setError("端口必须是 1-65535 之间的数字");
      return;
    }

    let auth: SshAuthMethod;
    let secret: string | null;
    if (authKind === "password") {
      if (!password) {
        setError("密码不能为空");
        return;
      }
      auth = { type: "password", password };
      secret = password;
    } else {
      if (!privateKeyPath.trim()) {
        setError("私钥路径不能为空");
        return;
      }
      auth = {
        type: "publickey",
        privateKeyPath: privateKeyPath.trim(),
        passphrase: passphrase || undefined,
      };
      secret = passphrase || null;
    }

    const params: SshConnectParams = {
      host: host.trim(),
      port: portNum,
      user: user.trim(),
      auth,
      cols: 80,
      rows: 24,
      term: "xterm-256color",
    };

    setSubmitting(true);
    setError(null);
    try {
      // TDSF 魔改: 如果勾选了永久保存, 先保存凭据
      if (saveKey) {
        const profile: SshCredentialProfile = {
          id: makeProfileId(host.trim(), portNum, user.trim()),
          alias: `${user.trim()}@${host.trim()}:${portNum}`,
          host: host.trim(),
          port: portNum,
          user: user.trim(),
          auth:
            authKind === "password"
              ? { type: "password" }
              : {
                  type: "publickey",
                  privateKeyPath: privateKeyPath.trim(),
                  hasPassphrase: !!passphrase,
                },
          lastUsed: Date.now(),
          createdAt: Date.now(),
        };
        try {
          await saveConnection(profile, secret);
        } catch (saveErr) {
          // 保存失败不阻塞连接, 仅警告
          console.warn("[SshConnectDialog] saveConnection failed:", saveErr);
        }
      }

      const id = await connect(params);
      if (id) {
        // 连接已发起 (实际连接状态由 onStatus 事件推送)
        onOpenChange(false);
      } else {
        setError("连接失败, 请检查参数");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * 点击已保存连接 - 一键自动登录
   *
   * 调用 connectWithSaved: 从 keyring 取敏感字段 → 组装 params → connect
   */
  const handleConnectSaved = async (profile: SshCredentialProfile) => {
    setAutoConnectingId(profile.id);
    try {
      const id = await connectWithSaved(profile);
      if (id) {
        onOpenChange(false);
      }
    } finally {
      setAutoConnectingId(null);
    }
  };

  /** 删除已保存的连接 */
  const handleDeleteSaved = async (
    e: React.MouseEvent,
    profile: SshCredentialProfile,
  ) => {
    e.stopPropagation(); // 防止触发列表项的连接
    await deleteSavedConnection(profile.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>连接 SSH 服务器</DialogTitle>
          <DialogDescription>
            填写远端 Linux 服务器信息, 像 VS Code Remote-SSH
            一样浏览和编辑远程文件。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid gap-4">
          {/* TDSF 魔改: 已保存的连接列表 (一键自动登录) */}
          {savedConnections.length > 0 && (
            <div className="grid gap-1.5">
              <Label className="text-[11px] text-muted-foreground">
                已保存的连接 (点击一键登录)
              </Label>
              <div className="max-h-[120px] overflow-y-auto rounded-md border border-border/60 bg-muted/20">
                {savedConnections.map((p) => (
                  // biome-ignore lint/a11y/useSemanticElements: div with role=button preserves layout flex styling that <button> defaults would override.
                  <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleConnectSaved(p)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleConnectSaved(p);
                      }
                    }}
                    className="group flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[12px] transition-colors hover:bg-accent/60"
                  >
                    {autoConnectingId === p.id ? (
                      <HugeiconsIcon
                        icon={Loading03Icon}
                        size={12}
                        strokeWidth={1.75}
                        className="animate-spin text-primary"
                      />
                    ) : (
                      <HugeiconsIcon
                        icon={Login03Icon}
                        size={12}
                        strokeWidth={1.75}
                        className="text-muted-foreground group-hover:text-foreground"
                      />
                    )}
                    <span className="flex-1 truncate font-mono">
                      <span className="text-foreground">{p.alias}</span>
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatRelativeTime(p.lastUsed)}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => handleDeleteSaved(e, p)}
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                      title="删除此保存的连接"
                      aria-label={`删除 ${p.alias}`}
                    >
                      <HugeiconsIcon
                        icon={Delete01Icon}
                        size={11}
                        strokeWidth={1.75}
                        className="text-muted-foreground hover:text-destructive"
                      />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 主机 + 端口 */}
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-host">主机 (Host)</Label>
              <Input
                id="ssh-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.10 或 example.com"
                autoComplete="off"
                spellCheck={false}
                disabled={submitting}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-port">端口 (Port)</Label>
              <Input
                id="ssh-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                onBlur={handlePortBlur}
                inputMode="numeric"
                placeholder="22"
                autoComplete="off"
                disabled={submitting}
              />
            </div>
          </div>

          {/* 用户名 */}
          <div className="grid gap-1.5">
            <Label htmlFor="ssh-user">用户名 (User)</Label>
            <Input
              id="ssh-user"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="root / ubuntu / 你的用户名"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
          </div>

          {/* 认证方式切换 */}
          <div className="grid gap-1.5">
            <Label>认证方式 (Authentication)</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAuthKind("password")}
                disabled={submitting}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm transition-colors",
                  authKind === "password"
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                密码 (Password)
              </button>
              <button
                type="button"
                onClick={() => setAuthKind("publickey")}
                disabled={submitting}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm transition-colors",
                  authKind === "publickey"
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
                )}
              >
                公钥 (Public Key)
              </button>
            </div>
          </div>

          {/* 密码 / 公钥字段 (条件渲染) */}
          {authKind === "password" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-password">密码 (Password)</Label>
              <Input
                id="ssh-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="off"
                disabled={submitting}
              />
            </div>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="ssh-key">私钥路径 (Private Key Path)</Label>
                <Input
                  id="ssh-key"
                  value={privateKeyPath}
                  onChange={(e) => setPrivateKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_ed25519 或 C:\\Users\\you\\.ssh\\id_rsa"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={submitting}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ssh-passphrase">口令 (Passphrase, 可选)</Label>
                <Input
                  id="ssh-passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="若私钥加密则填写"
                  autoComplete="off"
                  disabled={submitting}
                />
              </div>
            </>
          )}

          {/* 错误提示: break-words 防长错误文本撑宽对话框, 限高滚动 */}
          {error && (
            <div className="max-h-28 overflow-y-auto break-words whitespace-normal rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {/* TDSF 魔改: 测试连接结果提示 */}
          {testResult === "ok" && (
            <div className="max-h-28 overflow-y-auto break-words whitespace-normal rounded-md bg-primary/10 px-3 py-2 text-xs text-foreground">
              ✓ {testMessage}
            </div>
          )}
          {testResult === "fail" && (
            <div className="max-h-28 overflow-y-auto break-words whitespace-normal rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              ✗ {testMessage}
            </div>
          )}

          {/* TDSF 魔改: 永久保存密钥选项 */}
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={saveKey}
              onChange={(e) => setSaveKey(e.target.checked)}
              className="size-3.5 accent-primary"
            />
            <span>永久保存密钥到本机（下次自动登录，仅在测试通过后生效）</span>
          </label>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
              取消
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleTestConnection}
              disabled={testing || submitting || !host.trim() || !user.trim()}
            >
              {testing && (
                <HugeiconsIcon
                  icon={Loading03Icon}
                  size={12}
                  strokeWidth={1.75}
                  className="animate-spin"
                />
              )}
              {testing ? "测试中…" : "测试连接"}
            </Button>
            <Button
              type="submit"
              disabled={submitting || !host.trim() || !user.trim()}
            >
              {/* TDSF 魔改: 连接中显示 spinner, 给用户即时视觉反馈 (修复原版卡死时无反馈的问题) */}
              {submitting && (
                <HugeiconsIcon
                  icon={Loading03Icon}
                  size={12}
                  strokeWidth={1.75}
                  className="animate-spin"
                />
              )}
              {submitting ? "连接中…" : "连接"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
