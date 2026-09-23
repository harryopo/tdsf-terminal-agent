// TDSF 2026-07-31: 创建 Space 对话框
// -----------------------------------------------------------------------------
// 用户在创建新工作区时可选择:
//   - 本地工作区 (Local Workspace): 使用当前 workspaceEnv 启动本地 PTY
//   - WSL 工作区 (2026-08-28 用户反馈新增): 选择 WSL 发行版, 首终端落在 WSL home
//   - SSH 服务器 (SSH Server): 填写 SSH 连接信息, 连接成功后创建 SSH Space
//
// 设计要点:
//   - 本地/WSL/SSH 模式通过顶部选项卡切换
//   - SSH 模式复用 sshStore.connect 建立会话, 成功后把 sessionId 写入 Space.env
//   - WSL 模式复用 useWorkspaceEnvStore.refreshDistros 拉发行版列表
//   - 新建 Space 后自动在该 Space 下创建一个 Terminal Tab
//   - 对话框关闭或成功时重置表单, 避免下次打开残留
//
// 2026-09-23 重排（用户实测三条）:
//   ① 弹窗原先 `max-w-md` 且**没有任何最大高度**，SSH 档实测 448×767（视口才 822）
//      —— 顶满整窗。改宽到 720px、内容区限高内部滚动。
//   ② SSH 档改成两栏：左列已保存的服务器（可就地看详情、可删除），右列表单。
//   ③ **状态只有一槽**。原先 `testResult`（测试连接）与 `error`（校验/创建失败）是两个
//      互不相干的块，谁也不清谁 —— 用户截图里"连接成功"和"SSH 连接失败"同屏就是这么来的。
//      现在任何一条新结果都覆盖旧结果，结构上不可能再同屏打架。

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
  CubeIcon,
  Delete02Icon,
  EyeIcon,
  EyeOffIcon,
  InformationCircleIcon,
  Loading03Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSshStore } from "../../ssh-explorer/sshStore";
import type { SpaceMeta } from "../lib/store";
import { useSpaces } from "../lib/useSpaces";
import { useWorkspaceEnvStore, LOCAL_WORKSPACE } from "@/modules/workspace";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** TDSF 2026-08-01: 初始模式（欢迎界面可预设 local/wsl/ssh） */
  initialMode?: Mode;
  /** 本地 Space 默认根目录 */
  defaultRoot: string | null;
  /** Space 创建成功后的回调, 由 App.tsx 负责创建第一个 Tab 并切换 */
  onCreated: (space: SpaceMeta, sshSessionId?: string) => void;
};

type Mode = "local" | "wsl" | "ssh";

type AuthKind = "password" | "publickey";

/** 全弹窗唯一的结果/错误槽（见文件头第 ③ 条） */
type Status = { kind: "ok" | "fail"; text: string; raw?: string } | null;

function makeProfileId(host: string, port: number, user: string): string {
  return `${user}@${host}:${port}`;
}

/** 详情里那行"最后使用"——拿不到就不显示，不编一个时间 */
function formatLastUsed(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function SpaceCreateDialog({
  open,
  onOpenChange,
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
  const deleteSavedConnection = useSshStore((s) => s.deleteSavedConnection);

  // === 通用状态 ===
  const [mode, setMode] = useState<Mode>("local");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  // === WSL 表单状态（2026-08-28 用户反馈新增） ===
  const wslDistros = useWorkspaceEnvStore((s) => s.distros);
  const wslLoading = useWorkspaceEnvStore((s) => s.loading);
  const wslError = useWorkspaceEnvStore((s) => s.error);
  const refreshDistros = useWorkspaceEnvStore((s) => s.refreshDistros);
  const [wslDistro, setWslDistro] = useState("");

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

  // === 已保存服务器：详情展开 / 删除确认 / 明文密码（2026-09-23 用户要求） ===
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  /** 明文只在点眼睛后存在这里；收起、切档、关窗一律清空（不落任何持久层） */
  const [revealed, setRevealed] = useState<{ id: string; secret: string } | null>(
    null,
  );
  const [revealing, setRevealing] = useState(false);

  const defaultName = useMemo(() => {
    if (mode === "ssh")
      return host.trim() ? `${user.trim()}@${host.trim()}` : "";
    if (mode === "wsl") return wslDistro ? `WSL ${wslDistro}` : "";
    return `Space ${spaces.length + 1}`;
  }, [mode, host, user, wslDistro, spaces.length]);

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
      setStatus(null);
      setWslDistro("");
      setHost("");
      setPort("22");
      setUser("");
      setAuthKind("password");
      setPassword("");
      setPrivateKeyPath("");
      setPassphrase("");
      setSaveKey(true);
      setTesting(false);
      setDetailId(null);
      setConfirmDeleteId(null);
      setRevealed(null);
      return;
    }
    if (!initializedRef.current) {
      initializedRef.current = true;
      // TDSF 2026-08-01: 打开时应用初始模式（欢迎界面预设 local/wsl/ssh）
      setMode(initialMode);
      setName(defaultName);
      void loadSavedConnections();
      // WSL 发行版列表预取——仅在从未加载过时调用（wsl.exe -l 有冷启动开销，
      // 每次打开对话框都拉会拖慢弹窗；与 WorkspaceEnvSelector 的惰性策略一致）
      if (useWorkspaceEnvStore.getState().distros.length === 0) {
        void refreshDistros();
      }
    }
  }, [open, defaultName, loadSavedConnections, initialMode, refreshDistros]);

  useEffect(() => {
    setName(defaultName);
  }, [mode, defaultName]);

  // 切换认证方式时清空敏感字段
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 authKind 变化时清空, 故意只依赖 authKind
  useEffect(() => {
    setPassword("");
    setPassphrase("");
    setRevealed(null);
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
      // 这条本来就是人话（"密码为空且系统密钥库中无已保存凭据…"），不再套翻译
      setStatus({
        kind: "fail",
        text: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    setTesting(true);
    setStatus(null);
    try {
      const r = await testConnection(resolved);
      setStatus({
        kind: r.ok ? "ok" : "fail",
        text: r.ok ? "" : r.message,
        raw: r.raw ?? "",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "fail", text: msg, raw: msg });
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
    setStatus(null);
    setName(`${p.user}@${p.host}`);
  };

  const toggleDetail = (id: string) => {
    if (detailId === id) {
      setDetailId(null);
      setConfirmDeleteId(null);
      setRevealed(null);
      return;
    }
    setDetailId(id);
    setConfirmDeleteId(null);
    setRevealed(null);
  };

  /** 眼睛：只有点开那一刻才去密钥库取，取到才显示；再点即清 */
  const toggleReveal = async (id: string) => {
    if (revealed?.id === id) {
      setRevealed(null);
      return;
    }
    setRevealing(true);
    try {
      const secret = await sshCredentialsGetSecret(id);
      setRevealed(secret ? { id, secret } : null);
      if (!secret) {
        setStatus({
          kind: "fail",
          text: "这条保存在系统密钥库里没有密码（可能只存了私钥路径）。",
        });
      }
    } catch (e) {
      setRevealed(null);
      setStatus({
        kind: "fail",
        text: `取不到已保存的密码：${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setRevealing(false);
    }
  };

  const handleDelete = async (p: SshCredentialProfile) => {
    try {
      await deleteSavedConnection(p.id);
      if (detailId === p.id) {
        setDetailId(null);
        setRevealed(null);
      }
      if (confirmDeleteId === p.id) setConfirmDeleteId(null);
    } catch (e) {
      setStatus({
        kind: "fail",
        text: `删除失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  const validateSsh = ():
    (Omit<SshConnectParams, "port"> & { port: number }) | null => {
    if (!host.trim() || !user.trim()) {
      setStatus({ kind: "fail", text: "主机和用户名为必填项" });
      return null;
    }
    const portNum = Number.parseInt(port, 10);
    if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) {
      setStatus({ kind: "fail", text: "端口必须是 1-65535 之间的数字" });
      return null;
    }

    let auth: SshAuthMethod;
    if (authKind === "password") {
      // 密码可空：已保存连接由 resolveAuth 从系统密钥库取密
      auth = { type: "password", password };
    } else {
      if (!privateKeyPath.trim()) {
        setStatus({ kind: "fail", text: "私钥路径不能为空" });
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
      env: LOCAL_WORKSPACE,
    });
    onCreated(meta);
    onOpenChange(false);
  };

  // TDSF 2026-08-28（用户反馈）: WSL 工作区创建。
  // root 置 null —— activeSpace.freshTabCwd 对 WSL Space 返回 null，
  // 首终端不带 cwd 启动，Rust 端 build_wsl 用 `--cd ~` 落在 WSL home。
  const handleCreateWsl = () => {
    if (!wslDistro) return;
    const spaceName = name.trim() || defaultName || `WSL ${wslDistro}`;
    const meta = createSpace({
      name: spaceName,
      root: null,
      env: { kind: "wsl", distro: wslDistro },
    });
    onCreated(meta);
    onOpenChange(false);
  };

  const handleCreateSsh = async () => {
    const params = validateSsh();
    if (!params) return;

    setSubmitting(true);
    setStatus(null);

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

      // 2026-09-01 修复（用户实测：新建 SSH 工作区弹出俩、名字不一样）：
      // 旧顺序先 connectSsh 后 createSpace——App 的 connect-success 订阅在
      // 连接成功时按 host/user 找工作区，此刻对话框的工作区还不存在，订阅
      // 便自建一个 `user@host` 工作区，随后对话框又建用户命名的那个 →
      // 双工作区。改为**先建工作区再连接**（连接成功后补写 env.sessionId；
      // 连接失败回滚删除孤儿工作区）。订阅侧按 host/user 匹配到本工作区，
      // 不会重复创建。
      const spaceName = name.trim() || defaultName;
      const meta = createSpace({
        name: spaceName,
        root: `/home/${params.user}`,
        env: {
          kind: "ssh",
          host: params.host,
          user: params.user,
          port: params.port,
          label: spaceName,
        },
      });

      const sessionId = await connectSsh(resolved);
      if (!sessionId) {
        useSpaces.getState().remove(meta.id);
        setStatus({ kind: "fail", text: "SSH 连接失败, 请检查参数或网络" });
        return;
      }

      useSpaces.getState().setEnv(meta.id, {
        kind: "ssh",
        host: params.host,
        user: params.user,
        port: params.port,
        label: spaceName,
        sessionId,
      });
      onCreated(meta, sessionId);
      onOpenChange(false);
    } catch (e) {
      setStatus({
        kind: "fail",
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "local") {
      handleCreateLocal();
    } else if (mode === "wsl") {
      handleCreateWsl();
    } else {
      void handleCreateSsh();
    }
  };

  const nameField = (
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
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 内容区限高 + 内部滚动：SSH 档字段最多，原先无上限，实测顶到 767px（视口 822） */}
      <DialogContent className="max-h-[85vh] gap-4 overflow-y-auto sm:max-w-[720px]">
        <DialogHeader className="gap-1.5">
          <DialogTitle>新建工作区</DialogTitle>
          <DialogDescription>
            选择本地、WSL 或 SSH 服务器工作区, 每个 Space 可包含多个 Terminal
            Tab。
          </DialogDescription>
        </DialogHeader>

        {/* 模式选择 */}
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ["local", "本地工作区", TerminalIcon],
              ["wsl", "WSL", CubeIcon],
              ["ssh", "SSH 服务器", CloudServerIcon],
            ] as const
          ).map(([m, label, icon]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-sm transition-colors",
                mode === m
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-muted",
              )}
            >
              <HugeiconsIcon icon={icon} size={14} strokeWidth={1.75} />
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="grid gap-4">
          {mode === "ssh" ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
              {/* 左列：已保存的服务器（详情就地展开、可删除） */}
              <div className="grid gap-1.5 md:min-h-0">
                <Label>已保存的服务器</Label>
                {savedConnections.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border/60 px-2.5 py-3 text-[11px] text-muted-foreground">
                    还没有保存过服务器。填好下面的信息并勾上「永久保存」，下次就能从这里直接选。
                  </p>
                ) : (
                  <ul className="max-h-[19rem] overflow-y-auto rounded-md border border-border/60">
                    {savedConnections.map((p) => {
                      const expanded = detailId === p.id;
                      const lastUsed = formatLastUsed(p.lastUsed);
                      return (
                        <li
                          key={p.id}
                          className={cn(
                            "border-b border-border/40 last:border-b-0",
                            expanded && "bg-muted/30",
                          )}
                        >
                          <div className="flex items-center gap-1 px-1">
                            <button
                              type="button"
                              onClick={() => applySavedProfile(p)}
                              disabled={submitting}
                              className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1.5 text-left text-[12px] hover:bg-muted/60 disabled:opacity-50"
                            >
                              <span className="truncate font-medium text-foreground">
                                {p.alias || `${p.user}@${p.host}`}
                              </span>
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {p.auth.type === "password" ? "密码" : "公钥"}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleDetail(p.id)}
                              aria-label={`查看 ${p.alias || p.id} 详情`}
                              aria-expanded={expanded}
                              className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              <HugeiconsIcon
                                icon={InformationCircleIcon}
                                size={14}
                                strokeWidth={1.75}
                              />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setConfirmDeleteId(
                                  confirmDeleteId === p.id ? null : p.id,
                                )
                              }
                              aria-label={`删除 ${p.alias || p.id}`}
                              className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            >
                              <HugeiconsIcon
                                icon={Delete02Icon}
                                size={14}
                                strokeWidth={1.75}
                              />
                            </button>
                          </div>

                          {confirmDeleteId === p.id && (
                            <div className="mx-1.5 mb-1.5 flex items-center justify-between gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                              <span>删除本机保存的这条凭据？工作区不受影响。</span>
                              <div className="flex shrink-0 gap-1">
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => setConfirmDeleteId(null)}
                                >
                                  取消
                                </Button>
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="destructive"
                                  onClick={() => void handleDelete(p)}
                                >
                                  删除
                                </Button>
                              </div>
                            </div>
                          )}

                          {expanded && (
                            <dl
                              data-testid="saved-server-detail"
                              className="mx-1.5 mb-2 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-md border border-border/50 bg-background/60 px-2.5 py-2 text-[11px]"
                            >
                              <dt className="text-muted-foreground">主机</dt>
                              <dd className="break-all font-mono">{p.host}</dd>
                              <dt className="text-muted-foreground">端口</dt>
                              <dd className="font-mono">{p.port ?? 22}</dd>
                              <dt className="text-muted-foreground">用户名</dt>
                              <dd className="break-all font-mono">{p.user}</dd>
                              <dt className="text-muted-foreground">认证</dt>
                              <dd>{p.auth.type === "password" ? "密码" : "公钥"}</dd>
                              {p.auth.type === "publickey" &&
                                p.auth.privateKeyPath && (
                                  <>
                                    <dt className="text-muted-foreground">私钥</dt>
                                    <dd className="break-all font-mono">
                                      {p.auth.privateKeyPath}
                                    </dd>
                                  </>
                                )}
                              {p.auth.type === "password" && (
                                <>
                                  <dt className="text-muted-foreground">密码</dt>
                                  <dd className="flex items-center gap-1.5">
                                    <span className="min-w-0 flex-1 break-all font-mono">
                                      {revealed?.id === p.id
                                        ? revealed.secret
                                        : "••••••••"}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => void toggleReveal(p.id)}
                                      disabled={revealing}
                                      aria-label={
                                        revealed?.id === p.id
                                          ? "隐藏密码"
                                          : "显示密码"
                                      }
                                      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                                    >
                                      <HugeiconsIcon
                                        icon={
                                          revealed?.id === p.id
                                            ? EyeOffIcon
                                            : EyeIcon
                                        }
                                        size={13}
                                        strokeWidth={1.75}
                                      />
                                    </button>
                                  </dd>
                                </>
                              )}
                              {lastUsed && (
                                <>
                                  <dt className="text-muted-foreground">
                                    最后使用
                                  </dt>
                                  <dd>{lastUsed}</dd>
                                </>
                              )}
                            </dl>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* 右列：连接表单 */}
              <div className="grid min-w-0 gap-4">
                {nameField}

                {/* 主机 + 端口 */}
                <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
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
                    {(
                      [
                        ["password", "密码 (Password)"],
                        ["publickey", "公钥 (Public Key)"],
                      ] as const
                    ).map(([kind, label]) => (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => setAuthKind(kind)}
                        disabled={submitting}
                        className={cn(
                          "h-9 rounded-md border px-3 text-sm transition-colors",
                          authKind === kind
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border bg-background text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {label}
                      </button>
                    ))}
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
                      <Label htmlFor="ssh-key">
                        私钥路径 (Private Key Path)
                      </Label>
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

                {/* P1 2026-08-01: 测试连接。size 与底部按钮统一成 h-9 ——
                    原先 size="sm"(h-8) 紧贴 h-9 的取消/创建，实测差 4px 看着就是"没对齐" */}
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleTestConnection()}
                    disabled={
                      submitting || testing || !host.trim() || !user.trim()
                    }
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
                </div>
              </div>
            </div>
          ) : (
            <div className="grid gap-4">
              {nameField}

              {mode === "wsl" && (
                <div className="grid gap-1.5">
                  <Label htmlFor="wsl-distro">WSL 发行版 (Distro)</Label>
                  {wslDistros.length > 0 ? (
                    <select
                      id="wsl-distro"
                      value={wslDistro}
                      onChange={(e) => setWslDistro(e.target.value)}
                      disabled={submitting}
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20"
                    >
                      <option value="" disabled>
                        选择发行版…
                      </option>
                      {wslDistros.map((d) => (
                        <option key={d.name} value={d.name}>
                          {d.name}
                          {d.default ? "（默认）" : ""}
                          {d.running ? " · running" : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2 text-[12px] text-muted-foreground">
                      <span>
                        {wslLoading
                          ? "正在探测 WSL 发行版…"
                          : wslError
                            ? `WSL 不可用：${wslError}`
                            : "未找到 WSL 发行版"}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void refreshDistros()}
                        disabled={wslLoading}
                      >
                        重新探测
                      </Button>
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    首个终端将启动在所选发行版的 home 目录，命令预测按 Linux
                    环境处理。
                  </p>
                </div>
              )}
            </div>
          )}

          {/* #111 + 2026-09-23：全弹窗唯一一条结果，自己一行、允许换行，
              并且**只有这一条**——成功与失败不可能同屏。
              原先 testResult 与 error 是两块互不清除的独立区域。 */}
          {status && (
            <div
              data-testid="space-create-test-result"
              title={status.raw || undefined}
              className={cn(
                "max-h-28 overflow-y-auto break-words whitespace-normal rounded-md px-3 py-2 text-[11px]",
                status.kind === "ok"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-destructive/10 text-destructive",
              )}
            >
              {status.kind === "ok"
                ? "连接成功（点击下方「连接并创建」进入服务器）"
                : status.text || "连接失败（服务器没有给出原因）"}
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
                (mode === "wsl"
                  ? !wslDistro
                  : mode === "ssh"
                    ? !host.trim() || !user.trim()
                    : false)
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
              {mode === "ssh" ? "连接并创建" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
