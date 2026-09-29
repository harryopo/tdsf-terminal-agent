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
//
// 2026-09-23 二次重排（用户看完成品再提三条）:
//   ④ **删掉左列的就地「详情」面板**。点一行本来就已经把 host/port/user/认证方式回填到
//      右侧表单，再在列表里嵌一块 `<dl>` 等于把同一件事说两遍；那块小字既不能编辑也不能
//      操作，就是用户说的"UI 做得很鸡肋"。密码那只眼睛因此搬进表单的密码行 —— 它服务的
//      是"这条连接的密码从哪来"，留在列表里反而看不懂。
//   ⑤ 左列改成 flex 列 + 列表 `flex-1`：原先 ul 是固定 `max-h-[19rem]`，右侧表单比它高时
//      列表下面就挂着**一块没人认领的空洞**。现在面板随行高撑满，空洞结构上不存在。
//   ⑥ 右列收成一条两列栅格（窄列只给端口），其余字段跨两列、标签基线齐平；「测试连接」
//      从独占一行改为与「永久保存」同行两端对齐。
//      ⑤⑥ 这两条几何事实由 `pnpm probe:dialog` 在真机量 —— happy-dom 不做布局，
//      单测里 `getBoundingClientRect()` 全是 0，量不出"对齐"这件事。

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
  Loading03Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import {
  formatLastUsed,
  savedServerConfirmation,
} from "../lib/savedServerConfirmation";
import { SshFailureDiagnoseDialog } from "../../ssh-explorer/SshFailureDiagnoseDialog";
import { describeSshFailureText } from "../../ssh-explorer/lib/sshErrorText";
import {
  diagnoseSshFailure,
  type SshDiagnosis,
} from "../../ssh-explorer/lib/sshFailureDiagnosis";
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
  /** 2026-09-28 用户实测⑤：失败时按步骤拆出来的诊断结论（详细窗的内容） */
  const [diagnosis, setDiagnosis] = useState<SshDiagnosis | null>(null);

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

  // === 已保存服务器：删除确认 / 明文密码（2026-09-23 用户要求） ===
  // #166 ③：删除确认从列表底部的红色横条改成正式弹窗（全应用同一只 ConfirmDeleteDialog），
  // 所以这里存的是"哪一条要删"，不再是"哪一条正在行内等第二次点击"。
  const [deleteTarget, setDeleteTarget] = useState<SshCredentialProfile | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
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

  /**
   * 2026-09-28 用户实测④：「测试连接」的结果只属于 SSH 那一档。
   * 旧行为是切到「本地工作区 / WSL」后红字仍然挂在弹窗里，看着像在说本地/WSL 失败了。
   */
  const switchMode = (next: Mode) => {
    if (next !== "ssh") {
      setStatus(null);
      setDiagnosis(null);
    }
    setMode(next);
  };

  /** 认得出的失败按四步拆开；关窗/重开不残留（下面的 open 复位 effect 清） */
  const openDiagnosis = (raw: string) => {
    const portNum = Number.parseInt(port, 10);
    setDiagnosis(
      diagnoseSshFailure(raw, {
        host: host.trim() || undefined,
        port: Number.isFinite(portNum) ? portNum : undefined,
        user: user.trim() || undefined,
      }),
    );
  };

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
      setDiagnosis(null);
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
      setDeleteTarget(null);
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
    setDiagnosis(null);
    try {
      const r = await testConnection(resolved);
      setStatus({
        kind: r.ok ? "ok" : "fail",
        text: r.ok ? "" : r.message,
        raw: r.raw ?? "",
      });
      // 2026-09-28 用户实测⑤：测试连接是他主动点的，失败就直接把分步结论摊开，
      // 不用他再去猜"卡在哪一步"（认不出格式的错误也弹，窗口里写明判不出来 + 原始信息）
      if (!r.ok) openDiagnosis(r.raw ?? r.message);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "fail", text: msg, raw: msg });
      openDiagnosis(msg);
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
    setDeleting(true);
    try {
      await deleteSavedConnection(p.id);
      if (revealed?.id === p.id) setRevealed(null);
    } catch (e) {
      // 确认窗会盖住下面的状态行，失败写在状态行等于没说：走 toast（#110 一次失败只说一次）
      toast.error(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
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
        // sshStore 的 toast 已经把原因说过一次（#110「一次失败只说一次」），
        // 这里不再弹详细窗，只把同一条错误落到状态槽 + 备好分步结论，由他决定点不点「查看诊断」。
        const failure = useSshStore.getState().lastConnectFailure;
        const raw = failure?.raw ?? "";
        setStatus({
          kind: "fail",
          text: raw
            ? describeSshFailureText(raw)
            : "SSH 连接失败，请检查参数或网络",
          raw,
        });
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

  const nameField = (extra?: string) => (
    <div className={cn("grid gap-1.5", extra)}>
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

  /**
   * 「当前表单是不是正好等于某条已保存的服务器」——**派生**而不是另存一个 id：
   * 用户手改过主机/端口/用户名之后高亮就该自己消失，多一份 state 迟早和表单不一致。
   */
  const selectedProfile = useMemo(
    () =>
      savedConnections.find(
        (p) =>
          p.host === host.trim() &&
          p.user === user.trim() &&
          String(p.port ?? 22) === port.trim(),
      ),
    [savedConnections, host, user, port],
  );
  /** 明文只显示在密码框里，且只在"当前选中的就是取密钥那条"时显示 */
  const secretShown = Boolean(
    revealed && selectedProfile && revealed.id === selectedProfile.id,
  );
  const canRevealSecret =
    authKind === "password" &&
    selectedProfile?.auth.type === "password" &&
    !password.trim();
  const selectedLastUsed = formatLastUsed(selectedProfile?.lastUsed);

  const deleteConfirmation = deleteTarget
    ? savedServerConfirmation(deleteTarget)
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 内容区限高 + 内部滚动：SSH 档字段最多，原先无上限，实测顶到 767px（视口 822） */}
      <DialogContent className="max-h-[70vh] gap-4 overflow-y-auto sm:max-w-[720px]">
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
              onClick={() => switchMode(m)}
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
              {/* 左列：面板随行高撑满，说明钉在面板底。原先 ul 是固定 max-h，
                  右侧表单比它高时列表下面就是**一块没人认领的空洞**
                  （用户 2026-09-23：留白异常）。空洞与否由 probe:dialog 真机量。 */}
              <div
                data-testid="ssh-saved-column"
                className="flex min-h-0 flex-col gap-1.5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <Label>已保存的服务器</Label>
                  {savedConnections.length > 0 && (
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      共 {savedConnections.length} 台
                    </span>
                  )}
                </div>

                {/* 面板是一整块有底色的容器，说明钉在它的底部：
                    右侧表单比列表高时，这块剩余空间由面板本身认领，不留白 */}
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/60 bg-muted/20">
                  {savedConnections.length === 0 ? (
                    <p className="flex min-h-0 flex-1 items-center justify-center px-3 py-4 text-center text-[11px] leading-relaxed text-muted-foreground">
                      还没有保存过服务器。填好右侧信息并勾上「永久保存」，
                      下次就能从这里直接选。
                    </p>
                  ) : (
                    <ul
                      data-testid="saved-server-list"
                      className="min-h-0 flex-1 divide-y divide-border/40 overflow-y-auto"
                    >
                      {savedConnections.map((p) => (
                        <li key={p.id} className="flex items-center gap-1 p-1">
                          <button
                            type="button"
                            data-testid="saved-server-row"
                            onClick={() => applySavedProfile(p)}
                            disabled={submitting}
                            aria-pressed={selectedProfile?.id === p.id}
                            className={cn(
                              "min-w-0 flex-1 rounded px-1.5 py-1 text-left transition-colors disabled:opacity-50",
                              selectedProfile?.id === p.id
                                ? "bg-primary/10 ring-1 ring-primary/40"
                                : "hover:bg-muted/60",
                            )}
                          >
                            <span className="block truncate text-[12px] font-medium text-foreground">
                              {p.alias || `${p.user}@${p.host}`}
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                              {p.user}@{p.host}:{p.port ?? 22} ·{" "}
                              {p.auth.type === "password" ? "密码" : "公钥"}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(p)}
                            aria-label={`删除 ${p.alias || p.id}`}
                            className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <HugeiconsIcon
                              icon={Delete02Icon}
                              size={14}
                              strokeWidth={1.75}
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* 删除确认改成正式弹窗（#166 ③），挂在 DialogContent 之外，理由同诊断窗 */}

                  {/* 说明钉在面板底部：这一格剩下的空间由它认领，而不是留成空白 */}
                  <p className="shrink-0 border-t border-border/40 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                    {selectedProfile
                      ? `已选用，连接信息已填入右侧表单${
                          selectedLastUsed ? `（上次 ${selectedLastUsed}）` : ""
                        }。`
                      : "选中一项即把连接信息填入右侧表单。已保存的密码不写入表单，也不显示。"}
                  </p>
                </div>
              </div>

              {/* 右列：一条三列栅格 —— 主机 / 端口 / 用户名 同一行三格，其余字段跨满。
                  每个字段都是"标签在上、输入在下"，标签都是单行，左边界与基线全部对齐。
                  少一行 = 少 64px：弹窗原先纵向顶到视口 76%，被 probe:dialog 的 72% 上限判红 */}
              <div
                data-testid="ssh-form-column"
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_4.5rem_minmax(0,1fr)] gap-x-3 gap-y-3"
              >
                {nameField("col-span-3")}

                <div className="grid gap-1.5">
                  <Label htmlFor="ssh-host">主机</Label>
                  <Input
                    id="ssh-host"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.10"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={submitting}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ssh-port">端口</Label>
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

                <div className="grid gap-1.5">
                  <Label htmlFor="ssh-user">用户名</Label>
                  <Input
                    id="ssh-user"
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                    placeholder="root"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={submitting}
                  />
                </div>

                <div className="col-span-3 grid gap-1.5">
                  <Label>认证方式</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        ["password", "密码"],
                        ["publickey", "公钥"],
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
                  <div className="col-span-3 grid gap-1.5">
                    <div className="flex min-h-5 items-center justify-between gap-2">
                      <Label htmlFor="ssh-password">密码</Label>
                      {/* 眼睛挪到表单里：已保存的密码本来就只服务于这条连接，
                          再在左列单开一块"详情"就是把同一件事说两遍 */}
                      {canRevealSecret && selectedProfile && (
                        <button
                          type="button"
                          onClick={() => void toggleReveal(selectedProfile.id)}
                          disabled={revealing}
                          aria-label={
                            secretShown ? "隐藏已保存的密码" : "显示已保存的密码"
                          }
                          className="flex h-5 items-center gap-1 rounded px-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                          <HugeiconsIcon
                            icon={secretShown ? EyeOffIcon : EyeIcon}
                            size={13}
                            strokeWidth={1.75}
                          />
                          {secretShown ? "隐藏" : "显示已保存的密码"}
                        </button>
                      )}
                    </div>
                    <Input
                      id="ssh-password"
                      type={secretShown && revealed ? "text" : "password"}
                      value={
                        password ||
                        (secretShown && revealed ? revealed.secret : "")
                      }
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="留空即用本机密钥库中已存的密码"
                      autoComplete="off"
                      disabled={submitting}
                    />
                  </div>
                ) : (
                  <>
                    <div className="col-span-3 grid gap-1.5">
                      <Label htmlFor="ssh-key">私钥路径</Label>
                      <Input
                        id="ssh-key"
                        value={privateKeyPath}
                        onChange={(e) => setPrivateKeyPath(e.target.value)}
                        placeholder="~/.ssh/id_ed25519"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={submitting}
                      />
                    </div>
                    <div className="col-span-3 grid gap-1.5">
                      <Label htmlFor="ssh-passphrase">口令（可选）</Label>
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

                {/* 勾选与「测试连接」并成一行：原先测试连接独占一行、右边什么都没有，
                    看着就是"下面还该有点什么"的空洞。尺寸都是 h-9，与底部按钮同高 */}
                <div className="col-span-3 flex h-9 items-center justify-between gap-3">
                  <label className="flex min-w-0 cursor-pointer select-none items-center gap-2 text-[12px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={saveKey}
                      onChange={(e) => setSaveKey(e.target.checked)}
                      className="size-3.5 shrink-0 accent-primary"
                      disabled={submitting}
                    />
                    <span className="truncate">永久保存密钥到本机（下次自动登录）</span>
                  </label>
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
              {nameField()}

              {mode === "wsl" && (
                <div className="grid gap-1.5">
                  <Label htmlFor="wsl-distro">WSL 发行版</Label>
                  {wslDistros.length > 0 ? (
                    // #166 ④：原生 <select> 弹的是操作系统那套方角列表（用户原话
                    // "太生硬"），换成与全应用同一只圆角 Select。
                    <Select
                      value={wslDistro}
                      onValueChange={setWslDistro}
                      disabled={submitting}
                    >
                      <SelectTrigger id="wsl-distro" className="w-full">
                        <SelectValue placeholder="选择发行版…" />
                      </SelectTrigger>
                      <SelectContent>
                        {wslDistros.map((d) => (
                          <SelectItem key={d.name} value={d.name}>
                            {d.name}
                            {d.default ? "（默认）" : ""}
                            {d.running ? " · 运行中" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                "flex items-start gap-2 rounded-md px-3 py-2 text-[11px]",
                status.kind === "ok"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-destructive/10 text-destructive",
              )}
            >
              <span
                data-testid="space-create-test-result-text"
                className="max-h-28 min-w-0 flex-1 overflow-y-auto break-words whitespace-normal"
              >
                {status.kind === "ok"
                  ? "连接成功（点击下方「连接并创建」进入服务器）"
                  : status.text || "连接失败（服务器没有给出原因）"}
              </span>
              {status.kind === "fail" && status.raw ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="space-create-diagnose"
                  onClick={() => openDiagnosis(status.raw ?? "")}
                  className="h-6 shrink-0 px-2 text-[11px]"
                >
                  查看诊断
                </Button>
              ) : null}
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
      {/* 诊断窗挂在同一个 DialogRoot 里、由 Radix 各自 portal 到 body：
          放在 DialogContent 内部会被弹窗壳层的 overflow 裁掉（#125 那条"看不见比难看更糟"） */}
      <SshFailureDiagnoseDialog
        open={diagnosis !== null}
        diagnosis={diagnosis}
        onClose={() => setDiagnosis(null)}
      />
      <ConfirmDeleteDialog
        request={deleteConfirmation}
        busy={deleting}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        onConfirm={() => {
          if (deleteTarget) void handleDelete(deleteTarget);
        }}
      />
    </Dialog>
  );
}
