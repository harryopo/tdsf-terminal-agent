/**
 * SSH 主机密钥确认框的文案唯一来源（TOFU 与"密钥已变更"两种情形）。
 *
 * 为什么单独成模块：原先两种情形各自只有一句"可能存在中间人攻击"，用户既不知道
 * **自己这台机器为什么会变**（重装/回快照是 99% 的真实原因），也不知道**该敲什么命令去核对**
 * （`ssh_host_ed25519_key.pub` 要跟着算法换）。文案散在组件里就没法测，所以收成纯函数。
 *
 * 口径：可能原因按**可能性从高到低**排，中间人一定列在最后但不省略 —— 不列是失职，
 * 只列中间人会把用户吓得不敢连自己的实验虚机。
 *
 * 语域：安全提示是要人照着做的说明书，**用书面语**（用户 2026-09-23 明确指出第一版太口语）。
 * 界面按纯文本渲染，所以说明里不写 markdown 反引号 —— 反引号会原样出现在屏幕上。
 */

export interface HostKeySituation {
  /** true = 已知主机的密钥变了；false = 首次连接（TOFU） */
  isMismatch: boolean;
  /** 服务器公钥算法，如 `ssh-ed25519`；拿不到时给通用命令 */
  keyType?: string;
}

export interface HostKeyGuidance {
  title: string;
  /** 情形说明卡：一句话说清"现在发生了什么、为什么要你确认" */
  summary: string;
  /** 可能原因，从高到低；界面上按编号渲染 */
  causes: string[];
  /** 在服务器本机执行的核对命令（按算法给对应文件名） */
  verifyCommand: string;
  /** 指纹文件名，用于说明"在哪台机器上跑" */
  verifyNote: string;
  approveLabel: string;
  rejectLabel: string;
  /** 危险情形：主按钮走警示色 */
  danger: boolean;
}

/** 算法 → 服务器上的主机公钥文件名（对齐 OpenSSH 默认布局） */
const HOST_KEY_FILE: Record<string, string> = {
  "ssh-ed25519": "ssh_host_ed25519_key.pub",
  ed25519: "ssh_host_ed25519_key.pub",
  "ssh-rsa": "ssh_host_rsa_key.pub",
  rsa: "ssh_host_rsa_key.pub",
  "ecdsa-sha2-nistp256": "ssh_host_ecdsa_key.pub",
  "ecdsa-sha2-nistp384": "ssh_host_ecdsa_key.pub",
  "ssh-dss": "ssh_host_dsa_key.pub",
};

export function hostKeyVerifyCommand(keyType?: string): string {
  const file = keyType
    ? HOST_KEY_FILE[keyType.trim().toLowerCase()]
    : undefined;
  return `ssh-keygen -lf /etc/ssh/${file ?? "ssh_host_*_key.pub"}`;
}

const MISMATCH_CAUSES = [
  "服务器重装过操作系统、回滚至较早的快照，或重新生成过主机密钥（例如执行 ssh-keygen -A，或 sshd 首次启动）。该成因最为常见。",
  "当前 IP 地址与端口指向了另一台主机：虚拟机重建、DHCP 重新分配地址、端口转发的目标发生变更，均属此类。",
  "该主机更换过网卡或调整过主机名解析，而本机 known_hosts 中保留的仍是其先前的记录。",
  "网络路径上存在替换服务器身份的中转方（中间人攻击）。在仅供个人使用的隔离实验网络中概率较低；在公共网络环境下，务必先以带外方式核对指纹，再行信任。",
];

const FIRST_CONNECT_CAUSES = [
  "本机首次连接该地址，此前未保存过任何记录。",
  "服务器为新部署或刚完成重装，其主机密钥为新生成。",
  "该 IP 地址此前分配给其他主机，现已换用当前主机。",
];

/** 两种情形共用：界面按纯文本渲染，说明里不得出现 markdown 反引号 */
const VERIFY_NOTE =
  "请在被连接的服务器上执行以下命令，将所得 SHA256 指纹与上方数值逐项比对；两者不一致时不应选择信任。";

export function hostKeyGuidance(s: HostKeySituation): HostKeyGuidance {
  const verifyCommand = hostKeyVerifyCommand(s.keyType);
  if (s.isMismatch) {
    return {
      title: "主机密钥已变更",
      summary:
        "本机此前已记录该主机的公钥指纹，而本次连接所收到的指纹与该记录不一致。" +
        "该差异通常源于服务器端主机密钥的重新生成，亦不排除网络路径上存在身份替换。" +
        "请在批准连接之前完成下方指纹核对，确认无误后再行信任。",
      causes: MISMATCH_CAUSES,
      verifyCommand,
      verifyNote: VERIFY_NOTE,
      approveLabel: "我已核对，信任并连接",
      rejectLabel: "拒绝",
      danger: true,
    };
  }
  return {
    title: "首次连接该主机",
    summary:
      "本机首次连接该地址，known_hosts 中尚无可供比对的记录，下方指纹由服务器在本次连接中直接提供。" +
      "确认无误后，本机将保存该指纹；此后该指纹一旦变更即会触发警示。" +
      "此即 TOFU（Trust On First Use，首次使用即信任）策略。",
    causes: FIRST_CONNECT_CAUSES,
    verifyCommand,
    verifyNote: VERIFY_NOTE,
    approveLabel: "信任并连接",
    rejectLabel: "取消",
    danger: false,
  };
}
