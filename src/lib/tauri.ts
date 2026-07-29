/**
 * tauri.ts — TDSF Terminal Agent Tauri 2 IPC 客户端
 * -----------------------------------------------------------------------------
 * 封装前端 ↔ Rust 后端的所有 IPC 调用:
 *   - 健康检查: ping / get_version / get_build_info
 *   - PTY: spawn / write / resize / kill / list + pty://output / pty://exit 事件
 *
 * 运行环境检测:
 *   - __TAURI_INTERNALS__: Tauri 2 注入的全局对象, 仅在 Tauri 窗口存在
 *   - 浏览器预览模式 (pnpm dev) 下为 undefined, 调用前必须判断
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// === 类型定义 ================================================================

export interface SpawnOptions {
  /** 自定义 shell 路径, 不传则用系统默认 (Windows cmd.exe / Unix $SHELL) */
  shell?: string | null;
  /** 初始列数, 默认 80 */
  cols?: number | null;
  /** 初始行数, 默认 24 */
  rows?: number | null;
  /** 透传环境变量 (key, value) 二元组 */
  env?: Array<[string, string]> | null;
}

export interface PtyInfo {
  id: string;
  shell: string;
  cols: number;
  rows: number;
  created_at: string;
}

export interface VersionInfo {
  name: string;
  version: string;
  rust_version: string;
}

export interface BuildInfo {
  version: VersionInfo;
  started_at: string;
  uptime_secs: number;
}

export interface PtyOutputEvent {
  id: string;
  /** PTY 原始输出 (UTF-8 lossy) */
  data: string;
}

export interface PtyExitEvent {
  id: string;
  code: number;
}

// === 运行环境检测 ============================================================

/**
 * 是否在 Tauri 容器内运行
 * - true:  tauri dev / tauri build
 * - false: 纯浏览器预览 (vite dev 打开浏览器)
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// === 健康检查 (P0) ============================================================

export async function ping(): Promise<string> {
  return invoke<string>('ping');
}

export async function getVersion(): Promise<VersionInfo> {
  return invoke<VersionInfo>('get_version');
}

export async function getBuildInfo(): Promise<BuildInfo> {
  return invoke<BuildInfo>('get_build_info');
}

// === PTY (P2) =================================================================

/**
 * 启动 PTY 会话
 * - 返回 PtyInfo 含会话 ID
 * - 后端会自动启动后台 task 监听 output/exit 并 emit 到前端
 */
export async function ptySpawn(opts: SpawnOptions = {}): Promise<PtyInfo> {
  return invoke<PtyInfo>('pty_spawn', { opts });
}

/**
 * 写入数据到 PTY stdin
 * - 字符串直接写入 (自动 UTF-8 编码)
 * - 后端用 portable-pty 0.8 写入 master
 */
export async function ptyWrite(id: string, data: string): Promise<void> {
  return invoke<void>('pty_write', { id, data });
}

/**
 * 调整 PTY 尺寸
 * - P2 MVP 暂为 noop, P2.1 实现
 */
export async function ptyResize(
  id: string,
  cols: number,
  rows: number
): Promise<void> {
  return invoke<void>('pty_resize', { id, cols, rows });
}

/** 终止 PTY 会话 (drop master, 触发子进程关闭) */
export async function ptyKill(id: string): Promise<void> {
  return invoke<void>('pty_kill', { id });
}

/** 列出所有活跃 PTY 会话 */
export async function ptyList(): Promise<PtyInfo[]> {
  return invoke<PtyInfo[]>('pty_list');
}

// === PTY 事件订阅 =============================================================

/**
 * 订阅 PTY 输出事件
 * @returns unlisten 函数, 调用后取消订阅
 */
export async function onPtyOutput(
  cb: (event: PtyOutputEvent) => void
): Promise<UnlistenFn> {
  return listen<PtyOutputEvent>('pty://output', (e) => cb(e.payload));
}

/**
 * 订阅 PTY 退出事件
 */
export async function onPtyExit(
  cb: (event: PtyExitEvent) => void
): Promise<UnlistenFn> {
  return listen<PtyExitEvent>('pty://exit', (e) => cb(e.payload));
}
