/**
 * #110：把 Rust 抛上来的 SSH 连接错误翻成人话，并给出**真实存在**的下一步入口。
 *
 * 触发场景（用户 2026-09-22 实测截图）：点进已有的 SSH 工作区 → 自动重连 → 弹两条 toast，
 * 第一条正文是 `SSH connect failed: authentication failed for user root: Failure {
 * remaining_methods: MethodSet([PublicKey]), partial_success: false }` —— 那是 russh 的
 * Rust Debug 结构体，用户读不出"该做什么"。而 `remaining_methods: [PublicKey]` 其实信息量很大：
 * **服务器不接受密码登录**（OpenSSH 在 `PermitRootLogin prohibit-password` 下就是这个形状），
 * 只是我们从来没把它讲出来。
 *
 * 口径：认得出的形状就讲人话 + 指一个界面上真有的入口（"SSH 面板"已经不存在了，见 #109，
 * 不许再往文案里写）；认不出的**原样保留**，绝不为了文案干净把线索吞掉。
 */

export interface SshFailureCopy {
  /** toast 标题：一句话说清"哪儿不对" */
  headline: string;
  /** toast 正文：为什么 + 下一步做什么 */
  description: string;
}

/** 界面上真实存在的凭据入口（#109：独立的 SSH 连接面板已无入口，别指它） */
const CREDENTIAL_ENTRY = "「新建工作区 → SSH 服务器」";

/** russh 的 `Auth::Failure` Debug 形状：`Failure { remaining_methods: MethodSet([PublicKey, Password]), partial_success: false }` */
const REMAINING_METHODS = /remaining_methods:\s*MethodSet\(\s*\[([^\]]*)\]\s*\)/i;

/**
 * 服务器还肯接受哪些方式。注意这是**服务器可提供的清单**，与"密码填错"无关：
 * 密码错时 OpenSSH 仍然会把 password 留在清单里，所以清单里没有 password
 * 就等于"这台机器压根不接受密码"，而不是"你密码打错了"。
 */
function parseRemainingMethods(raw: string): string[] | null {
  const m = REMAINING_METHODS.exec(raw);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function describeSshFailure(raw: string): SshFailureCopy {
  const msg = raw ?? "";
  const methods = parseRemainingMethods(msg);

  if (methods && !methods.some((m) => /password/i.test(m))) {
    const only = methods.length === 1 ? `只接受 ${methods[0]}` : `仍接受 ${methods.join(" / ")}`;
    return {
      headline: "服务器不接受密码登录",
      description: `这台 sshd 现在${only}（常见于 Ubuntu 默认的 PermitRootLogin prohibit-password）。` +
        `请在${CREDENTIAL_ENTRY}把认证方式切成「公钥」并填私钥路径；` +
        `确实要用密码的话，得先在服务器上打开 PasswordAuthentication。`,
    };
  }

  if (methods) {
    return {
      headline: "用户名或密码不对",
      description: `服务器仍接受 ${methods.join(" / ")}，但拒绝了这次凭据。` +
        `请在${CREDENTIAL_ENTRY}重填密码（或换一种认证方式）。`,
    };
  }

  if (/authentication failed|auth.*fail/i.test(msg)) {
    return {
      headline: "登录被拒绝",
      description: `凭据没通过。请在${CREDENTIAL_ENTRY}重填后再试。原始信息：${msg}`,
    };
  }

  if (
    /connection refused|no route to host|network is unreachable|timed?\s?-?out|broken pipe|transport error|Disconnect/i.test(
      msg,
    )
  ) {
    return {
      headline: "连不上这台服务器",
      description: `网络或 sshd 没在监听。确认 IP/端口与服务器开机状态后重试。原始信息：${msg}`,
    };
  }

  if (/kex|key exchange|invalid message|unknown|protocol/i.test(msg)) {
    return {
      headline: "SSH 协议协商失败",
      description: `多半是双方算法不兼容（服务器太旧或太新）。原始信息：${msg}`,
    };
  }

  return {
    headline: "SSH 连接失败",
    description: msg,
  };
}

/**
 * 单行版：给「测试连接」这类只有一段文本可放的地方用。
 *
 * 分两段呈现（标题 + 正文）的地方直接用 `describeSshFailure`，别再拼一遍。
 */
export function describeSshFailureText(raw: string): string {
  const { headline, description } = describeSshFailure(raw);
  return `${headline}：${description}`;
}
