// TDSF 魔改 (P4-T4.1): SSH 桥接层单测 — 纯函数 (不依赖 Tauri 运行时)
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
import { __testToRustAuth, type SshAuthMethod } from "./ssh-bridge";

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
