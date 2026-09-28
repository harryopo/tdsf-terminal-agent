export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const BOOT_CHECK_DELAY_MS = 8000;

const LAST_CHECK_KEY = "tdsf-update-last-check";

export function readLastCheckAt(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_CHECK_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeLastCheckAt(ts: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CHECK_KEY, String(ts));
  } catch {
    // 写不进去只影响"下次启动要不要再查一遍"，不值得报错
  }
}

/**
 * 只有查成功才记账（见 checkUpdate 的调用点）：失败还写时刻，等于让一次
 * 断网把用户挡在"下次启动再试"之外整整一天。
 */
export function shouldAutoCheck(
  now: number,
  lastCheckAt: number | null,
): boolean {
  return lastCheckAt === null || now - lastCheckAt >= UPDATE_CHECK_INTERVAL_MS;
}

export type InstallBlockerKey =
  | "sidecar-approvals"
  | "host-approvals"
  | "agent-running"
  | "pending-executions";

export type InstallBlocker = { key: InstallBlockerKey; text: string };

/**
 * 安装会直接结束进程（Windows 上 tauri 拉起安装器后 std::process::exit），
 * 任何"还没答完"或"结果还没回来"的事情都会当场丢证据 —— 所以这四类一律拒装，
 * 而不是"先装了再说"。至于后台标签页里用户自己挂着的命令，属于下载前那段
 * 确认文案已经明说的代价（见 downloadConfirmCopy），不做假精确的检测。
 */
export function collectInstallBlockers(input: {
  sidecarApprovals: number;
  hostApprovals: number;
  agentRunning: boolean;
  pendingExecutions: number;
}): InstallBlocker[] {
  const out: InstallBlocker[] = [];
  if (input.sidecarApprovals > 0) {
    out.push({
      key: "sidecar-approvals",
      text: `有 ${input.sidecarApprovals} 条命令在等你确认，先答完再更新。`,
    });
  }
  if (input.hostApprovals > 0) {
    out.push({
      key: "host-approvals",
      text: `有 ${input.hostApprovals} 条服务器主机密钥在等你确认，先答完再更新。`,
    });
  }
  if (input.agentRunning) {
    out.push({
      key: "agent-running",
      text: "智能体正在跑这一轮，等它结束再更新。",
    });
  }
  if (input.pendingExecutions > 0) {
    out.push({
      key: "pending-executions",
      text: `有 ${input.pendingExecutions} 条命令刚发到终端、结果还没回来，等它结算再更新。`,
    });
  }
  return out;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "未知大小";
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export type DownloadConfirmCopy = {
  title: string;
  description: string;
  confirm: string;
  cancel: string;
};

/**
 * 安装前必须说清"会发生什么"（#166 ⑤，用户原话：「点击确认更新，更新的时候注明要
 * 停下来当前的agent，停下来连接，然后重启更新什么的」）。
 *
 * `step` 就是 `installUpdate.ts` 里 `bestEffort("…")` 的那个标签，两边由
 * `update-install-steps.test.ts` 按顺序 1:1 钉住 —— 界面上列三件事、代码里做六件事，
 * 比少说更糟（用户会在应用突然消失时以为出了故障）。
 */
export const INSTALL_STEPS: ReadonlyArray<{ step: string; text: string }> = [
  { step: "cancel-turn", text: "停掉正在跑的这轮任务（AI 会被取消）" },
  { step: "disconnect-ssh", text: "断开本窗口建立的 SSH 连接" },
  { step: "close-pty", text: "关闭所有本地终端标签页" },
  { step: "kill-lsp", text: "停掉代码语言服务" },
  { step: "stop-sidecar", text: "停掉后台引擎（AI 运行时）" },
  { step: "install", text: "重启应用并安装新版本" },
];

/**
 * 下载前必须说清三件事：包有多大（全量安装包，NSIS 没有增量）、装完会重启、
 * 重启会断掉 SSH 与终端。少任何一句都会让用户在"应用突然消失"时以为出了故障。
 * 逐条影响列在弹窗的清单里（INSTALL_STEPS），这里只说体积与要重启这两件。
 */
export function downloadConfirmCopy(input: {
  version: string;
  bytes: number | null;
}): DownloadConfirmCopy {
  const size =
    input.bytes === null
      ? "更新包是完整安装包（不是增量），体积较大"
      : `更新包约 ${formatBytes(input.bytes)}，是完整安装包（不是增量）`;
  return {
    title: `更新到 ${input.version}`,
    description: `${size}。下载完成后需要重启应用完成安装，下面列的是安装时会发生的事。`,
    confirm: "下载更新",
    cancel: "稍后再说",
  };
}

/**
 * 认得出的失败给一句能照做的中文；认不出的**原样带出**，不为了界面干净吞掉线索
 * （与 sshErrorText 同一口径）。
 */
export function describeUpdateFailure(raw: unknown): string {
  const text =
    raw instanceof Error
      ? `${raw.name}: ${raw.message}`
      : typeof raw === "string"
        ? raw
        : String(raw);
  const low = text.toLowerCase();
  if (low.includes("not allowed") || low.includes("permission")) {
    return `这个窗口没有更新权限，请在主窗口里重试。原始信息：${text}`;
  }
  if (
    low.includes("signature") ||
    low.includes("verify") ||
    low.includes("invalid minisign")
  ) {
    return `更新包校验未通过，已放弃安装（不要重复重试，可能是发布端产物不匹配）。原始信息：${text}`;
  }
  if (low.includes("404") || low.includes("not found")) {
    return `没有找到更新清单：可能还没有正式发布过新版本。原始信息：${text}`;
  }
  // 用户 2026-09-28 实测①：装着 0.9.0 点检查更新，界面直接甩出插件的英文原文
  // `Could not fetch a valid release JSON from the remote`。这条的真实含义是
  // "远端没有可解析的已发布版本"（更新清单只解析已发布的 Release，草稿解析不出东西），
  // 不是本机坏了 —— 认出来就照这个说，别让用户去查自己的网络。
  if (low.includes("valid release json") || low.includes("release json")) {
    return `远端还没有可解析的正式版本：GitHub Releases 里最新的还是草稿，或更新清单没生成。这不是你这台机器的问题，等版本正式发布后再点重试即可。原始信息：${text}`;
  }
  if (
    low.includes("timed out") ||
    low.includes("timeout") ||
    low.includes("dns") ||
    low.includes("connect")
  ) {
    return `连不上更新服务器，检查网络后再试。原始信息：${text}`;
  }
  return `更新检查失败：${text}`;
}
