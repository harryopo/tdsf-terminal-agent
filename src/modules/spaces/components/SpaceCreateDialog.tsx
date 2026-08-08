// TDSF 魔改 2026-07-31: 创建 Space 对话框
// -----------------------------------------------------------------------------
// 用户在创建新工作区时可选择:
//   - 本地工作区 (Local Workspace): 使用当前 workspaceEnv 启动本地 PTY
//   - SSH 服务器 (SSH Server): 填写 SSH 连接信息, 连接成功后创建 SSH Space
//
// 设计要点:
//   - 本地模式与 SSH 模式通过顶部选项卡切换
//   - SSH 模式复用 sshStore.connect 建立会话, 成功后把 sessionId 写入 Space.env
//   - 新建 Space 后自动在该 Space 下创建一个 Terminal Tab
//   - 对话框关闭或成功时重置表单, 避免下次打开残留

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
import { sshCredentialsGetSecret } from "@/lib/ssh-bridge";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  CloudServerIcon,
  Loading03Icon,
  Square01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSshStore } from "../../ssh-explorer/sshStore";
import type { SpaceMeta } from "../lib/store";
import { useSpaces } from "../lib/useSpaces";
import type { WorkspaceEnv } from "@/modules/workspace";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** TDSF 2026-08-01: 初始模式（欢迎界面可预设 local/ssh） */
  initialMode?: Mode;
  /** 本地 Space 默认使用的环境 (local 或当前 WSL) */
  defaultEnv: WorkspaceEnv;
  /** 本地 Space 默认根目录 */
  defaultRoot: string | null;
  /** Space 创建成功后的回调, 由 App.tsx 负责创建第一个 Tab 并切换 */
  onCreated: (space: SpaceMeta, sshSessionId?: string) => void;
};

type Mode = "local" | "ssh";

type AuthKind = "password" | "publickey";

function makeProfileId(host: string, port: number, user: string): string {
  return `${user}@${host}:${port}`;
}

export function SpaceCreateDialog({
  open,
  onOpenChange,
  defaultEnv,
  defaultRoot,
  onCreated,
  initialMode = "local",
}: Props) {
  const spaces = useSpaces((s) => s.spaces);
  const createSpace = useSpaces((s) => s.create);
  const connectSsh = useSshStore((s) => s.connect);
  const saveConnection = useSshStore((s) => s.saveConnection);
  const testConnection = useSshStore((s) => s.testConnection);
  const savedConnections = useSshStore((s) => s.savedConnections);
  const loadSavedConnections = useSshStore((s) => s.loadSavedConnections);

  // === 通用状态 ===
  const [mode, setMode] = useState<Mode>("local");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // === SSH 表单状态 ===
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("password");
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [saveKey, setSaveKey] = useState(true);

  // === 测试连接状态（P1 2026-08-01: 对齐主界面 SSH 面板交互）===
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  const [testMessage, setTestMessage] = useState("");

  const defaultName = useMemo(() => {
    if (mode === "ssh") return host.trim() ? `${user.trim()}@${host.trim()}` : "";
    return `Space ${spaces.length + 1}`;
  }, [mode, host, user, spaces.length]);

  // 打开时重置表单; 打开瞬间应用初始模式 + 加载已保存连接。
  // TDSF 修复 2026-08-07: 原 effect 在 open 期间因依赖变化（defaultName /
  // loadSavedConnections 异步完成）反复执行 setMode(initialMode), 用户点击
  // ssh 选项卡后模式被强制重置回 local → 界面闪动且无法创建 SSH 工作区。
  // 用 initializedRef 保证初始化块只在每次打开的瞬间执行一次。
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      initializedRef.current = false;
      setName("");
      setSubmitting(false);
      setError(null);
      setHost("");
      setPort("22");
      setUser("");
      setAuthKind("password");
      setPassword("");
      setPrivateKeyPath("");
      setPassphrase("");
      setSaveKey(true);
      setTesting(false);
      setTestResult(null);
      setTestMessage("");
      return;
    }
    if (!initializedRef.current) {
      initializedRef.current = true;
      // TDSF 2026-08-01: 打开时应用初始模式（欢迎界面预设 local/ssh）
      setMode(initialMode);
      setName(defaultName);
      void loadSavedConnections();
    }
  }, [open, defaultName, loadSavedConnections, initialMode]);

  useEffect(() => {
    setName(defaultName);
  }, [mode, defaultName]);

  // 切换认证方式时清空敏感字段
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 authKind 变化时清空, 故意只依赖 authKind
  useEffect(() => {
    setPassword("");
    setPassphrase("");
  }, [authKind]);

  const handlePortBlur = () => {
    if (!port.trim()) setPort("22");
  };

  // P1 2026-08-01: 测试连接（走 Rust ssh_test，不保留会话，与主界面 SSH 面板一致）
  const handleTestConnection = async () => {
    const params = validateSsh();
    if (!params) return;
    let resolved: typeof params;
    try {
      resolved = await resolveAuth(params);
    } catch (e) {
      setTestResult("fail");
      setTestMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    setTesting(true);
    setTestResult(null);
    setTestMessage("");
    try {
      const r = await testConnection(resolved);
      setTestResult(r.ok ? "ok" : "fail");
      setTestMessage(r.message);
    } catch (e) {
      setTestResult("fail");
      setTestMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  // P1 2026-08-01: 已保存连接密码/口令为空时从系统密钥库取密
  const resolveAuth = async (
    params: Omit<SshConnectParams, "port"> & { port: number },
  ): Promise<Omit<SshConnectParams, "port"> & { port: number }> => {
    if (params.auth.type === "password" && !params.auth.password) {
      const secret = await sshCredentialsGetSecret(
        makeProfileId(params.host, params.port, params.user),
      );
      if (!secret) {
        throw new Error("密码为空且系统密钥库中无已保存凭据，请输入密码");
      }
      return { ...params, auth: { type: "password", password: secret } };
    }
    if (params.auth.type === "publickey" && !params.auth.passphrase) {
      const secret = await sshCredentialsGetSecret(
        makeProfileId(params.host, params.port, params.user),
      );
      if (secret) {
        return {
          ...params,
          auth: { ...params.auth, passphrase: secret },
        };
      }
    }
    return params;
  };

  // P1 2026-08-01: 从已保存连接回填表单（非敏感字段；密码/口令留空走 keyring）
  const applySavedProfile = (p: SshCredentialProfile) => {
    setHost(p.host);
    setPort(String(p.port ?? 22));
    setUser(p.user);
    if (p.auth.type === "password") {
      setAuthKind("password");
      setPassword("");
    } else {
      setAuthKind("publickey");
      setPrivateKeyPath(p.auth.privateKeyPath ?? "");
      setPassphrase("");
    }
    setError(null);
    setTestResult(null);
    setTestMessage("");
    setName(`${p.user}@${p.host}`);
  };

  const validateSsh = (): (Omit<SshConnectParams, "port"> & { port: number }) | null => {
    if (!host.trim() || !user.trim()) {
      setError("主机和用户名为必填项");
      return null;
    }
    const portNum = Number.parseInt(port, 10);
    if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) {
      setError("端口必须是 1-65535 之间的数字");
      return null;
    }

    let auth: SshAuthMethod;
    if (authKind === "password") {
      // 密码可空：已保存连接由 resolveAuth 从系统密钥库取密
      auth = { type: "password", password };
    } else {
      if (!privateKeyPath.trim()) {
        setError("私钥路径不能为空");
        return null;
      }
      auth = {
        type: "publickey",
        privateKeyPath: privateKeyPath.trim(),
        passphrase: passphrase || undefined,
      };
    }

    return {
      host: host.trim(),
      port: portNum,
      user: user.trim(),
      auth,
      cols: 80,
      rows: 24,
      term: "xterm-256color",
    };
  };

  const handleCreateLocal = () => {
    const spaceName = name.trim() || defaultName;
    const meta = createSpace({
      name: spaceName,
      root: defaultRoot,
      env: defaultEnv,
    });
    onCreated(meta);
    onOpenChange(false);
  };

  const handleCreateSsh = async () => {
    const params = validateSsh();
    if (!params) return;

    setSubmitting(true);
    setError(null);

    try {
      // P1 2026-08-01: 已保存连接密码/口令从系统密钥库取密
      const resolved = await resolveAuth(params);

      // 可选: 先保存凭据, 失败不阻塞连接
      if (saveKey) {
        const profile: SshCredentialProfile = {
          id: makeProfileId(params.host, params.port, params.user),
          alias: `${params.user}@${params.host}:${params.port}`,
          host: params.host,
          port: params.port,
          user: params.user,
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
          // P1 2026-08-01: 密码/口令为空时用 keyring 取到的值保存
          let savedSecret: string | null = null;
          if (resolved.auth.type === "password") {
            savedSecret = password || resolved.auth.password || null;
          } else {
            savedSecret = passphrase || resolved.auth.passphrase || null;
          }
          await saveConnection(profile, savedSecret);
        } catch (saveErr) {
          console.warn("[SpaceCreateDialog] saveConnection failed:", saveErr);
        }
      }

      const sessionId = await connectSsh(resolved);
      if (!sessionId) {
        setError("SSH 连接失败, 请检查参数或网络");
        return;
      }

      const spaceName = name.trim() || defaultName;
      const env: WorkspaceEnv = {
        kind: "ssh",
        host: params.host,
        user: params.user,
        port: params.port,
        label: spaceName,
        sessionId,
      };
      const meta = createSpace({
        name: spaceName,
        root: `/home/${params.user}`,
        env,
      });
      onCreated(meta, sessionId);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "local") {
      handleCreateLocal();
    } else {
      void handleCreateSsh();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建工作区 (New Space)</DialogTitle>
          <DialogDescription>
            选择本地工作区或连接 SSH 服务器, 每个 Space 可包含多个 Terminal Tab。
          </DialogDescription>
        </DialogHeader>

        {/* 模式选择 */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setMode("local")}
            className={cn(
              "flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
              mode === "local"
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-muted",
            )}
          >
            <HugeiconsIcon icon={Square01Icon} size={14} strokeWidth={1.75} />
            本地工作区
          </button>
          <button
            type="button"
            onClick={() => setMode("ssh")}
            className={cn(
              "flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
              mode === "ssh"
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-background text-muted-foreground hover:bg-muted",
            )}
          >
            <HugeiconsIcon icon={CloudServerIcon} size={14} strokeWidth={1.75} />
            SSH 服务器
          </button>
        </div>

        <form onSubmit={handleSubmit} className="grid gap-4">
          {/* 名称 */}
          <div className="grid gap-1.5">
            <Label htmlFor="space-name">
              名称 {mode === "ssh" ? "(默认 user@host)" : ""}
            </Label>
            <Input
              id="space-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultName}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
          </div>

          {mode === "ssh" && (
            <>
              {/* P1 2026-08-01: 已保存服务器列表（点击回填表单） */}
              {savedConnections.length > 0 && (
                <div className="grid gap-1.5">
                  <Label>已保存的服务器</Label>
                  <div className="max-h-28 overflow-auto rounded-md border border-border/60">
                    {savedConnections.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => applySavedProfile(p)}
                        disabled={submitting}
                        className="flex w-full items-center justify-between gap-2 border-b border-border/40 px-2.5 py-1.5 text-left text-[12px] last:border-b-0 hover:bg-muted/60 disabled:opacity-50"
                      >
                        <span className="truncate font-medium text-foreground">
                          {p.alias || `${p.user}@${p.host}`}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {p.auth.type === "password" ? "密码" : "公钥"}
                        </span>
                      </button>
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

              {/* 认证方式 */}
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
                    <Label htmlFor="ssh-passphrase">
                      口令 (Passphrase, 可选)
                    </Label>
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

              <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={saveKey}
                  onChange={(e) => setSaveKey(e.target.checked)}
                  className="size-3.5 accent-primary"
                  disabled={submitting}
                />
                <span>永久保存密钥到本机（下次自动登录）</span>
              </label>

              {/* P1 2026-08-01: 测试连接（与主界面 SSH 面板一致，不保留会话） */}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleTestConnection()}
                  disabled={submitting || testing || !host.trim() || !user.trim()}
                >
                  {testing && (
                    <HugeiconsIcon
                      icon={Loading03Icon}
                      size={12}
                      strokeWidth={1.75}
                      className="animate-spin"
                    />
                  )}
                  测试连接
                </Button>
                {testResult && (
                  <span
                    title={testResult === "ok" ? undefined : (testMessage || undefined)}
                    className={cn(
                      "min-w-0 flex-1 truncate text-[11px]",
                      testResult === "ok"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-destructive",
                    )}
                  >
                    {testResult === "ok"
                      ? "连接成功（点击下方「连接并创建」进入服务器）"
                      : `连接失败${testMessage ? `：${testMessage}` : ""}`}
                  </span>
                )}
              </div>
            </>
          )}

          {error && (
            <div className="max-h-28 overflow-y-auto break-words whitespace-normal rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

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
              type="submit"
              disabled={
                submitting ||
                (mode === "local"
                  ? false
                  : !host.trim() || !user.trim())
              }
            >
              {submitting && (
                <HugeiconsIcon
                  icon={Loading03Icon}
                  size={12}
                  strokeWidth={1.75}
                  className="animate-spin"
                />
              )}
              {mode === "local" ? "创建" : "连接并创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
