/**
 * SSH 主机密钥确认框的文案唯一来源（TOFU 与"密钥已变更"两种情形）。
 *
 * 为什么单独成模块：原先两种情形各自只有一句"可能存在中间人攻击"，用户既不知道
 * **自己这台机器为什么会变**（重装/回快照是 99% 的真实原因），也不知道**该敲什么命令去核对**
 * （`ssh_host_ed25519_key.pub` 要跟着算法换）。文案散在组件里就没法测，所以收成纯函数。
 *
 * 口径：可能原因按**可能性从高到低**排，中间人一定列在最后但不省略 —— 不列是失职，
 * 只列中间人会把用户吓得不敢连自己的实验虚机。
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
  "服务器重装了系统、恢复了快照，或重新生成过主机密钥（`ssh-keygen -A` / 首次启动 sshd）",
  "同一个 IP 和端口现在指向了另一台机器 —— 虚机重建、DHCP 重新分配、端口转发改了目标都会这样",
  "这台机器换过网卡或改过 hosts，本机 `known_hosts` 里留的是它早先的身份",
  "网络路径上有设备替换了服务器身份（中间人）。在只属于你的实验网里概率很低，但公共网络上必须先带外核对指纹再信任",
];

const FIRST_CONNECT_CAUSES = [
  "你第一次连接这个地址，本机还没有它的任何记录",
  "服务器是新建 / 刚重装完的，主机密钥是全新的",
  "这个 IP 之前分给了别的机器，现在换了一台",
];

export function hostKeyGuidance(s: HostKeySituation): HostKeyGuidance {
  const verifyCommand = hostKeyVerifyCommand(s.keyType);
  if (s.isMismatch) {
    return {
      title: "主机密钥已变更",
      summary:
        "这台主机本机记录的指纹，和它现在给出的不一致。继续之前请核对下面的指纹，" +
        "确认是这台机器自己变了，而不是有人在中间。",
      causes: MISMATCH_CAUSES,
      verifyCommand,
      verifyNote: "在服务器本机执行，比对 SHA256 指纹是否一致",
      approveLabel: "我已核对，信任并连接",
      rejectLabel: "拒绝",
      danger: true,
    };
  }
  return {
    title: "首次连接该主机",
    summary:
      "本机第一次连接这个地址，还没有可比对的记录。请核对指纹后再信任 —— " +
      "这是 TOFU（第一次使用即信任）：现在记下来，以后一旦变化就会报警。",
    causes: FIRST_CONNECT_CAUSES,
    verifyCommand,
    verifyNote: "在服务器本机执行，比对 SHA256 指纹是否一致",
    approveLabel: "信任并连接",
    rejectLabel: "取消",
    danger: false,
  };
}
