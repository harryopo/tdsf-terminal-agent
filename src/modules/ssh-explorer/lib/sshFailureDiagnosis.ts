/**
 * 2026-09-28 用户实测⑤：连接失败时要说清**卡在哪一步**，而不只是一句"失败了"。
 *
 * 判据来自链路本身的事实，不是猜的：
 * - Rust `SshClient::connect` 的顺序是 TCP 探测 → russh 握手（内含 `check_server_key`
 *   审批）→ 认证（见 client.rs 注释与 `[ssh] TCP+SSH handshake done` 日志行）。
 * - russh 只在 `check_server_key` 返回 Ok 之后才发认证请求 ⇒ **错误里出现
 *   `authentication failed` 就证明前三步都过了**，这是能把"已通过"标出来的依据。
 * - 认证失败时服务器还会回报 `remaining_methods`，那是**这台 sshd 允许哪些登录方式**，
 *   与"密码打错"无关（#110 已核实这条区分）。
 *
 * 文案的"人话部分"不在这里写第二份：标题与下一步指引复用 #110 的唯一主人
 * `describeSshFailure`，本模块只负责**分步结构**。认不出的形状一律标 `unknown`，
 * 不许把没证据的步骤说成通过了。
 */
import { describeSshFailure } from "./sshErrorText";

export type SshStageKey = "network" | "handshake" | "hostKey" | "auth";

export type SshStageState = "passed" | "failed" | "notReached" | "unknown";

export interface SshStage {
  key: SshStageKey;
  /** 界面上的步骤名 */
  label: string;
  state: SshStageState;
  /** 这一步的判定依据（说人话，不带 Rust 结构体） */
  note: string;
}

export interface SshDiagnosis {
  stages: SshStage[];
  /** 卡住的那一步；认不出来时为 null */
  stuckAt: SshStageKey | null;
  /** 服务器还接受哪些登录方式（从 remaining_methods 解析；解析不到为 null） */
  serverMethods: string[] | null;
  headline: string;
  description: string;
  /** 原始信息，界面折叠展示，不吞线索 */
  raw: string;
}

export interface SshFailureContext {
  host?: string;
  port?: number;
  user?: string;
}

/** russh `Auth::Failure` 的 Debug 形状，与 sshErrorText 认的是同一条 */
const REMAINING_METHODS = /remaining_methods:\s*MethodSet\(\s*\[([^\]]*)\]\s*\)/i;

function parseMethods(raw: string): string[] | null {
  const m = REMAINING_METHODS.exec(raw);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 网络层失败的字样：我们自己那条超时 Display 也算（`SSH 连接超时(10s): 服务器不可达或端口未开放`） */
const NETWORK =
  /连接超时|connection timed out|timed out|connection refused|no route to host|network is unreachable|getaddrinfo|name or service not known|dns|failed to connect/i;

/** 主机身份失败：TOFU 确认被拒 / 已知主机密钥变了 */
const HOST_KEY = /unknown server key|host key mismatch|hostkey|主机密钥|指纹/i;

/** 协议协商失败（算法不兼容 / 传输层被断） */
const HANDSHAKE =
  /kex|key exchange|invalid message|protocol|disconnect|transport error|corrupt message/i;

/** 认证阶段（含服务端拒绝与本地私钥读不到） */
const AUTH = /authentication failed|auth.*fail|permission denied|password|passphrase|private key|no authentication methods/i;

const LABELS: Record<SshStageKey, string> = {
  network: "① 连上服务器端口",
  handshake: "② SSH 协议握手",
  hostKey: "③ 核对主机身份（指纹）",
  auth: "④ 登录认证（用户名与凭据）",
};

function buildStages(
  stuckAt: SshStageKey | null,
  ctx: SshFailureContext,
  methods: string[] | null,
): SshStage[] {
  const order: SshStageKey[] = ["network", "handshake", "hostKey", "auth"];
  const endpoint =
    ctx.host && ctx.port ? `${ctx.host}:${ctx.port}` : (ctx.host ?? "目标地址");
  const who = ctx.user ? `（提交的用户名是 ${ctx.user}）` : "";
  const passedNote: Record<SshStageKey, string> = {
    network: `端口通的了（${endpoint}）`,
    handshake: "协议协商完成，双方算法兼容",
    hostKey: "主机指纹已被信任",
    auth: "凭据已被接受",
  };
  const failedNote: Record<SshStageKey, string> = {
    network: `这一步就没过：${endpoint} 连不上（地址解析、端口没开放或服务器没开机），SSH 还没开始谈协议。`,
    handshake: "TCP 通了，但 SSH 协议没谈成（多半是双方算法不兼容，或中途被断开）。",
    hostKey:
      "协议握手成功了，卡在这台机器的身份上：刚才的指纹确认被点了拒绝，或者这台主机换过密钥（重装过系统）。",
    auth:
      methods && !methods.some((m) => /password/i.test(m))
        ? "网络、握手、主机身份三步都过了，服务器在登录这一步把这次凭据拒了；而且它压根没把「密码」列为可用方式。"
        : methods
          ? `网络、握手、主机身份三步都过了，服务器仍接受这些登录方式，但拒绝了这一次提交的凭据${who}。`
          : `前面的步骤都走完了，登录这一步没通过${who}。`,
  };
  const notReached = "没走到（前面那步就断了）";

  return order.map((key) => {
    if (stuckAt === null) {
      return { key, label: LABELS[key], state: "unknown", note: "判不出这一步走到过没有" };
    }
    const idx = order.indexOf(key);
    const stuckIdx = order.indexOf(stuckAt);
    if (idx < stuckIdx) {
      return { key, label: LABELS[key], state: "passed", note: passedNote[key] };
    }
    if (idx === stuckIdx) {
      return { key, label: LABELS[key], state: "failed", note: failedNote[key] };
    }
    return { key, label: LABELS[key], state: "notReached", note: notReached };
  });
}

/**
 * 把一条 Rust 抛上来的 SSH 连接错误拆成"走到哪一步、卡在哪一步"。
 *
 * 判据按**具体程度**从前往后排：先认我们自己的超时/网络字样，再认主机身份与协议协商，
 * 最后才认认证字样。顺序别倒过来——`authentication failed` 那条消息里也含
 * `password` 之类的词，但它已经证明前三步过了。
 */
export function diagnoseSshFailure(
  rawInput: string,
  ctx: SshFailureContext = {},
): SshDiagnosis {
  const raw = rawInput ?? "";
  const methods = parseMethods(raw);

  let stuckAt: SshStageKey | null = null;
  if (NETWORK.test(raw)) {
    stuckAt = "network";
  } else if (HOST_KEY.test(raw)) {
    stuckAt = "hostKey";
  } else if (AUTH.test(raw)) {
    stuckAt = "auth";
  } else if (HANDSHAKE.test(raw)) {
    stuckAt = "handshake";
  }

  const copy = describeSshFailure(raw);
  return {
    stages: buildStages(stuckAt, ctx, methods),
    stuckAt,
    serverMethods: methods,
    headline: copy.headline,
    // 卡在网络/握手/主机身份时，#110 的文案已经指到该做的动作；认证那一档它写的
    // 就是"重填密码或换认证方式"，与本模块的分步结论一致，不再拼第二份。
    description: copy.description,
    raw,
  };
}
