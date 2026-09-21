// TDSF (P4-T4.1): SSH 桥接层单测 — 纯函数 (不依赖 Tauri 运行时)
//
// 覆盖:
//   - __testToRustAuth: camelCase (前端) → snake_case (Rust) 认证参数转换
//     - password: type + password 字段透传
//     - publickey: type + private_key_path (snake_case) + passphrase
//     - publickey 无 passphrase: passphrase 字段为 null (Rust Option::None)
//
// 不覆盖 (需 Tauri 运行时):
//   - sshConnect / sshWrite / sshResize / sshDisconnect / sshStatus / sshApproveHost
//   - subscribeHostVerify / subscribeHostKeyMismatch (需 Tauri event listener)
//   这些函数的集成测试应在 e2e 阶段通过真实 SSH 服务器验证。
import { describe, expect, it } from "vitest";
import {
  __testToRustAuth,
  PROBE_MARK,
  probeCmd,
  readProbeValue,
  type SshAuthMethod,
} from "./ssh-bridge";

describe("__testToRustAuth (camelCase → snake_case 转换)", () => {
  describe("password 认证", () => {
    it("正确转换 password 类型", () => {
      const auth: SshAuthMethod = {
        type: "password",
        password: "secret123",
      };
      const result = __testToRustAuth(auth);
      expect(result).toEqual({
        type: "password",
        password: "secret123",
      });
    });

    it("空密码透传 (前端校验由对话框负责)", () => {
      const auth: SshAuthMethod = {
        type: "password",
        password: "",
      };
      const result = __testToRustAuth(auth);
      expect(result.password).toBe("");
    });

    it("含特殊字符的密码透传", () => {
      const auth: SshAuthMethod = {
        type: "password",
        password: 'P@ss"w0rd!#$%',
      };
      const result = __testToRustAuth(auth);
      expect(result.password).toBe('P@ss"w0rd!#$%');
    });
  });

  describe("publickey 认证", () => {
    it("正确转换 private_key_path 为 snake_case", () => {
      const auth: SshAuthMethod = {
        type: "publickey",
        privateKeyPath: "/home/user/.ssh/id_ed25519",
      };
      const result = __testToRustAuth(auth);
      expect(result).toEqual({
        type: "publickey",
        private_key_path: "/home/user/.ssh/id_ed25519",
        passphrase: null,
      });
    });

    it("带 passphrase 时正确透传", () => {
      const auth: SshAuthMethod = {
        type: "publickey",
        privateKeyPath: "/home/user/.ssh/id_rsa",
        passphrase: "my-passphrase",
      };
      const result = __testToRustAuth(auth);
      expect(result).toEqual({
        type: "publickey",
        private_key_path: "/home/user/.ssh/id_rsa",
        passphrase: "my-passphrase",
      });
    });

    it("无 passphrase 时字段为 null (Rust Option::None)", () => {
      const auth: SshAuthMethod = {
        type: "publickey",
        privateKeyPath: "~/.ssh/id_ed25519",
      };
      const result = __testToRustAuth(auth);
      expect(result.passphrase).toBeNull();
    });

    it("空 passphrase 字符串时保持空字符串 (?? 仅对 null/undefined 生效)", () => {
      const auth: SshAuthMethod = {
        type: "publickey",
        privateKeyPath: "~/.ssh/id_ed25519",
        passphrase: "",
      };
      const result = __testToRustAuth(auth);
      // 代码用 `auth.passphrase ?? null`, 空字符串不是 nullish, 所以保持 ''
      expect(result.passphrase).toBe("");
    });

    it("Windows 路径正确透传", () => {
      const auth: SshAuthMethod = {
        type: "publickey",
        privateKeyPath: "C:\\Users\\user\\.ssh\\id_rsa",
      };
      const result = __testToRustAuth(auth);
      expect(result.private_key_path).toBe("C:\\Users\\user\\.ssh\\id_rsa");
    });
  });

  describe("type 字段一致性", () => {
    it('password type 字段为 "password"', () => {
      const result = __testToRustAuth({ type: "password", password: "x" });
      expect(result.type).toBe("password");
    });

    it('publickey type 字段为 "publickey"', () => {
      const result = __testToRustAuth({
        type: "publickey",
        privateKeyPath: "/key",
      });
      expect(result.type).toBe("publickey");
    });
  });
});

// ============================================================================
// probeCmd / readProbeValue —— 单值远端探测的哨兵协议
// ============================================================================
// 为什么需要：实测服务器（192.168.45.128）连**非交互 exec** 都会先往 stdout 吐一
// 段欢迎横幅（`echo $HOME` 因此返回 1802 字节，而 $HOME 只有 5 字节），且横幅末尾
// 常常不带换行 —— 于是横幅尾巴和值粘在同一行（`…温馨提示/root`）。这种形状下
// "取第一行""取最后一行""整段 trim"三种写法全错：
//   - sshStore 用首行 → 拿到横幅 → 资源管理器落到 /
//   - carapace 一键安装用整段 trim → 把横幅当路径拼进 SFTP 目标地址
// 唯一不依赖横幅换行的办法是自己在值前面打一个哨兵（自己的 echo 一定带换行）。
describe("probeCmd / readProbeValue (单值探测的哨兵协议)", () => {
  /** 实测形状：多行横幅，末尾无换行，值直接粘在横幅最后一行后面 */
  const GLUED_BANNER = [
    "Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-88-generic x86_64)",
    "*************************************************************",
    "*  提示：本服务器已开启防火墙，请联系管理员开放端口          *",
    "*************************************************************",
    "Last login: Mon Sep 21 19:37:24 2026 from 192.168.45.1",
  ].join("\n");

  it("probeCmd 把哨兵放在被探测命令之前（哨兵独占一行）", () => {
    expect(probeCmd("echo $HOME")).toBe(`echo ${PROBE_MARK}; echo $HOME`);
  });

  it("横幅与值粘在同一行（无换行）时仍取出值", () => {
    const output = `${GLUED_BANNER}${PROBE_MARK}\n/root\n`;
    expect(readProbeValue(output)).toBe("/root");
  });

  it("横幅末尾带换行时同样取出值", () => {
    const output = `${GLUED_BANNER}\n${PROBE_MARK}\n/root\n`;
    expect(readProbeValue(output)).toBe("/root");
  });

  it("干净输出（无横幅）正常取值", () => {
    expect(readProbeValue(`${PROBE_MARK}\n/root\n`)).toBe("/root");
  });

  it("值为空时返回 null（调用方按取不到降级，不能返回空串当真值）", () => {
    expect(readProbeValue(`${PROBE_MARK}\n\n`)).toBeNull();
    expect(readProbeValue(`${PROBE_MARK}\n`)).toBeNull();
  });

  it("哨兵缺失时返回 null（命令被改写到没跑成，不能把横幅当值）", () => {
    expect(readProbeValue(GLUED_BANNER)).toBeNull();
    expect(readProbeValue("")).toBeNull();
  });

  it("值里自带的空格外形不被 trim 破坏首尾之外的部分", () => {
    expect(readProbeValue(`${PROBE_MARK}\n  /opt/my app  \n`)).toBe(
      "/opt/my app",
    );
  });

  it("多条哨兵时取最后一条（前一条是回声，不是答案）", () => {
    const output = `${PROBE_MARK}\n/stale\n${PROBE_MARK}\n/root\n`;
    expect(readProbeValue(output)).toBe("/root");
  });
});
