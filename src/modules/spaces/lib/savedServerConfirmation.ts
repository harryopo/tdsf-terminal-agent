// 「新建工作区」弹窗里与已保存服务器有关的两件纯计算（#166 ③）
// -----------------------------------------------------------------------------
// 单独立文件而不是留在 SpaceCreateDialog.tsx：那只弹窗导出非组件函数会让
// react-refresh 失效（HMR 时整棵子树重挂载，用户看到弹窗自己关掉），
// lint 的 `react-refresh/only-export-components` 就是钉这件事的。

import type { DeleteConfirmation } from "@/components/ConfirmDeleteDialog";
import type { SshCredentialProfile } from "@/lib/ssh-bridge";

/** 上次使用时间：`YYYY-MM-DD HH:mm`；没有或非法值返回 null（调用方据此决定说不说） */
export function formatLastUsed(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 删除确认窗要说的话全部从这条记录本身派生（不另存一份文案，免得和列表对不上）。
 * 两句 impact 都是核对过的真事实：
 * - 密码/私钥口令会一起消失 —— Rust `ssh_credentials_delete` 删完 profile 再删 keyring；
 * - 工作区对象与已经连上的终端不受影响 —— 凭据只在下一次自动登录时才被读。
 */
export function savedServerConfirmation(
  p: SshCredentialProfile,
): DeleteConfirmation {
  const lastUsed = formatLastUsed(p.lastUsed);
  return {
    subject: "这台已保存的服务器",
    name: p.alias || `${p.user}@${p.host}`,
    impact:
      "本机保存的登录信息会一起删除，下次连接要重新填密码或私钥口令。已建好的工作区和正在连着的终端都不受影响。",
    facts: [
      { label: "地址", value: `${p.host}:${p.port}` },
      { label: "用户名", value: p.user },
      { label: "认证", value: p.auth.type === "password" ? "密码" : "公钥" },
      ...(lastUsed ? [{ label: "上次使用", value: lastUsed }] : []),
    ],
  };
}
