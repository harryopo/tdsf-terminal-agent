/**
 * sftp-bridge.ts — TDSF SFTP 桥接层 (T-P2-05)
 * -----------------------------------------------------------------------------
 * 封装与 Rust SFTP 模块的 Tauri invoke 通信。
 *
 * Rust 侧命令 (src-tauri/src/modules/ssh/mod.rs):
 *   - sftp_list(sessionId, path) -> SftpEntry[]
 *   - sftp_stat(sessionId, path) -> SftpAttrs
 *   - sftp_read(sessionId, path) -> number[]   (Vec<u8> 自动序列化为 number[])
 *   - sftp_write(sessionId, path, content: number[]) -> void
 *   - sftp_mkdir(sessionId, path) -> void
 *   - sftp_remove(sessionId, path) -> void
 *   - sftp_rename(sessionId, from, to) -> void
 *
 * 命名约定:
 *   - Tauri 2 invoke 参数:camelCase(默认)
 *   - Rust SftpEntry 字段:camelCase(#[serde(rename_all = "camelCase")])
 *   - Rust SftpAttrs 字段:camelCase(#[serde(rename_all = "camelCase")])
 *
 * 编码:
 *   SFTP 协议默认 UTF-8,中文文件名天然支持。
 *   Tauri invoke 参数中 String 即 Rust String(UTF-8),无需额外编码。
 *
 * Vec<u8> 序列化:
 *   Tauri 自动将 Rust Vec<u8> 序列化为前端 number[]。
 *   前端写入时也传 number[](Array.from(uint8Array))。
 *   大文件场景建议分块,此处暂未优化。
 */
import { invoke } from '@tauri-apps/api/core';

// === 类型定义 ================================================================

/**
 * SFTP 目录项 (与 Rust SftpEntry 对齐,camelCase)
 *
 * 对应 SFTP read_dir 返回的 DirEntry,字段精简后序列化为 JSON。
 */
export interface SftpEntry {
  /** 文件名 (不含路径,UTF-8) */
  name: string;
  /** 完整路径 (父路径 + name) */
  path: string;
  /** 是否目录 */
  isDir: boolean;
  /** 是否普通文件 */
  isFile: boolean;
  /** 是否符号链接 */
  isSymlink: boolean;
  /** 文件大小 (字节,目录为 0) */
  size: number;
  /** 修改时间 (Unix timestamp,秒) */
  modified: number;
  /** 权限字符串 (如 "rwxr-xr-x",无法获取时为 null) */
  permissions: string | null;
}

/** SFTP 文件属性 (stat 命令返回) */
export interface SftpAttrs {
  /** 文件大小 (字节) */
  size: number;
  /** 用户 ID */
  uid: number;
  /** 组 ID */
  gid: number;
  /** 权限位 (Unix mode,如 0o755 = 491) */
  permissions: number;
  /** 修改时间 (Unix timestamp,秒) */
  modified: number;
  /** 访问时间 (Unix timestamp,秒) */
  accessed: number;
}

// === 核心 API ================================================================

/**
 * 列出远程目录内容
 *
 * Rust 端会自动排序 (目录优先 + 名称字母序,UTF-8 Unicode 码点排序)。
 * 中文文件名按 Unicode 码点排序,大致符合拼音直觉 (但严格按码点,不按拼音)。
 *
 * @param sessionId SSH 会话 ID
 * @param path 远程目录绝对路径 (如 "/home/user")
 * @returns SftpEntry 数组 (已排序)
 *
 * @example
 * ```ts
 * const entries = await sftpList(1, '/home/user');
 * for (const e of entries) {
 *   console.log(e.isDirectory ? '[DIR]' : '[FILE]', e.name);
 * }
 * ```
 */
export async function sftpList(
  sessionId: number,
  path: string,
): Promise<SftpEntry[]> {
  return invoke<SftpEntry[]>('sftp_list', { sessionId, path });
}

/**
 * 查询文件属性 (stat)
 *
 * 返回文件的 size/uid/gid/permissions/modified/accessed 等元数据。
 */
export async function sftpStat(
  sessionId: number,
  path: string,
): Promise<SftpAttrs> {
  return invoke<SftpAttrs>('sftp_stat', { sessionId, path });
}

/**
 * 读取远程文件内容
 *
 * 全量读取 (整文件读入内存)。返回 Uint8Array。
 * 大文件场景建议分块,此处暂未优化。
 *
 * @returns Uint8Array (从 Rust Vec<u8> 序列化的 number[] 转换)
 */
export async function sftpRead(
  sessionId: number,
  path: string,
): Promise<Uint8Array> {
  // Rust Vec<u8> → Tauri 自动序列化为 number[]
  const data = await invoke<number[]>('sftp_read', { sessionId, path });
  return new Uint8Array(data);
}

/**
 * 写入远程文件 (覆盖)
 *
 * Rust 端 SFTP write 会创建文件 (若不存在) 或截断 (若存在),然后写入数据。
 *
 * @param content Uint8Array,会被转换为 number[] 传给 Rust
 */
export async function sftpWrite(
  sessionId: number,
  path: string,
  content: Uint8Array,
): Promise<void> {
  // Uint8Array → number[] (Rust 期望 Vec<u8>)
  await invoke('sftp_write', {
    sessionId,
    path,
    content: Array.from(content),
  });
}

/**
 * 创建远程目录
 */
export async function sftpMkdir(
  sessionId: number,
  path: string,
): Promise<void> {
  await invoke('sftp_mkdir', { sessionId, path });
}

/**
 * 删除远程文件 (仅文件,不递归删除目录)
 */
export async function sftpRemove(
  sessionId: number,
  path: string,
): Promise<void> {
  await invoke('sftp_remove', { sessionId, path });
}

/**
 * 重命名远程文件/目录
 */
export async function sftpRename(
  sessionId: number,
  from: string,
  to: string,
): Promise<void> {
  await invoke('sftp_rename', { sessionId, from, to });
}

/**
 * 上传本地文件到远程 (TDSF 魔改 2026-08-31: 资源管理器上传功能)
 *
 * Rust 端 param_complete::sftp_upload_file: 读盘 + SFTP 写都在 Rust 完成,
 * 前端只传路径, 大文件不经 IPC 搬运字节 (区别于 sftpWrite 的 number[] 中转)。
 *
 * @returns 上传字节数
 */
export async function sftpUploadFile(
  sessionId: number,
  localPath: string,
  remotePath: string,
): Promise<number> {
  return invoke<number>('sftp_upload_file', {
    sessionId,
    localPath,
    remotePath,
  });
}

// === 辅助函数 ================================================================

/**
 * 将 Uint8Array 解码为 UTF-8 字符串
 *
 * 用于 Monaco Editor 加载文件内容时,将二进制转为文本。
 * 支持 UTF-8 编码 (含中文),失败时返回 fallback 字符串。
 */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (e) {
    console.warn('[sftp-bridge] decodeUtf8 failed:', e);
    return '';
  }
}

/**
 * 将字符串编码为 Uint8Array (UTF-8)
 *
 * 用于 Monaco Editor 保存文件时,将文本转为二进制传给 Rust。
 */
export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * 拼接远程 POSIX 路径 (处理根目录 "/" 与末尾斜杠)
 *
 * TDSF 魔改: 供 sshStore / useRemoteFileTree 构造子路径使用。
 */
export function joinRemotePath(parent: string, name: string): string {
  const base = parent.endsWith('/') ? parent.slice(0, -1) : parent;
  const child = name.startsWith('/') ? name.slice(1) : name;
  return base === '' ? `/${child}` : `${base}/${child}`;
}
