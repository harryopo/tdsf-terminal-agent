/**
 * param-complete-client.ts — 命令参数动态补全前端客户端 (TDSF 2026-08-28)
 * -----------------------------------------------------------------------------
 * carapace 参数预测接入（spec: .trae/specs/add-carapace-param-completion/spec.md）。
 *
 * 三条链路，统一产出 SuggestionResult（source:'arg' / kind:'arg'，与
 * paramSuggest.suggestParams 的产出一致，acceptPrediction 的 token 替换逻辑共用）：
 *
 *   1. 本地 Windows：invoke('param_complete', { cmd, tokens, current })
 *      —— Rust 侧 spawn 打包内 carapace.exe（param_complete.rs 提供，并行开发中）。
 *      tokens 约定【含命令名】（Rust 侧自行决定如何拼 carapace 调用）。
 *   2. SSH 远端：invoke('ssh_command') 在远端执行
 *      `~/.local/bin/carapace <completer> export <tokens...> '<current>'`。
 *      tokens 约定【不含命令名】（carapace CLI 语义：completer 单独作第一个
 *      位置参数，其后是命令行已输入的词，最后一个是正在输入的词）。
 *   3. 回退：Fig specs 静态层（completionInjection 直接走 getCommandSpec +
 *      suggestParams，不在本文件）。
 *
 * 失败策略：任何 invoke/exec 失败都静默降级（返回 [] 或 null），绝不抛错打断
 * 输入流——参数预测是锦上添花，宁可无预测也不给错误预测或报错弹窗。
 */
import { invoke } from '@tauri-apps/api/core';
import { sshCommand } from './ssh-bridge';
import type { SuggestionResult } from './suggest-engine';

// ============================================================================
// 类型
// ============================================================================

/** carapace export 输出的单个候选（宽容解析：缺失字段取默认值） */
export interface CarapaceCandidate {
  value: string;
  description: string;
  /** carapace 候选分类标记（颜色 style 等），仅透传不参与合并逻辑 */
  tag?: string;
}

/** mergeCandidates 的可选参数（预留描述中文化钩子，spec P2 tldr-zh 选项级说明） */
export interface MergeOptions {
  /**
   * 候选描述中文化钩子：value → 中文说明。
   * 返回 undefined 表示无中文说明，用 carapace 原始 description 兜底。
   */
  zhDescription?: (value: string) => string | undefined;
}

/** installRemoteCarapace 的安装阶段（UI 进度文案映射见 SshCarapaceBadge） */
export type CarapaceInstallStage = 'preparing' | 'uploading' | 'configuring' | 'done';

// ============================================================================
// 常量（远端路径/命令模板——与 spec「安全红线」固定路径约定一致）
// ============================================================================

/** 远端 carapace 固定安装路径（spec 安全红线：仅上传官方 release 二进制到此路径） */
export const CARAPACE_REMOTE_PATH = '~/.local/bin/carapace';

/** 远端存在性检测：command -v 带路径参数检查该路径可执行文件是否存在 */
export const CARAPACE_CHECK_CMD = `command -v ${CARAPACE_REMOTE_PATH} >/dev/null 2>&1 && echo __TDSF_CARAPACE_YES__`;

/** 检测命令成功时的输出标记 */
export const CARAPACE_YES_MARK = '__TDSF_CARAPACE_YES__';

/** 安装第 1 步：建目录 + 顺便带回 $HOME（SFTP 上传需要绝对路径，~ 不会被 sftp 展开） */
export const CARAPACE_MKDIR_CMD = `mkdir -p ~/.local/bin && echo $HOME`;

/** 安装第 4 步：上传后 chmod + 验证（一条 exec 完成，~ 由远端 /bin/sh 展开） */
export const CARAPACE_CONFIGURE_CMD = `chmod +x ${CARAPACE_REMOTE_PATH} && ${CARAPACE_REMOTE_PATH} --version`;

// ============================================================================
// leaf ↔ SSH 会话注册表
// ============================================================================
//
// completionInjection（terminal 模块）在参数模式下需要知道该 leaf 绑定的
// SSH 会话才能发起远端补全，但直接 import sshStore 会造成 terminal →
// ssh-explorer 的反向耦合（transport seam 之前的架构红线）。改为注册表模式：
// SSH leaf 挂载时（PaneTreeView.SshLeafPane / SshTerminalHost）把
// rustSessionId 注册进来，completionInjection 只读注册表。
//
// 值是 Rust 端 rustSessionId（number，ssh_command / sftp_* invoke 的 sessionId
// 参数），不是 sshStore 的前端 UUID（string）——invoke 走 Rust 命令。

/**
 * 补全的 cwd 上下文（动态候选的准确性依赖当前目录）：
 *   - 本地：carapace 的 git branch / 文件路径 action 都按 cwd 执行 —— 本地
 *     leaf 的 cwd 由 useTerminalSession 的 OSC 7 跟踪，这里注册供查询。
 *   - 远端：ssh_command exec 的 cwd 是远端 home 而非 shell 当前目录 ——
 *     注册一个 getter（读 sshStore.currentPathBySession，getState 模式防
 *     stale closure），补全时生成 `cd '<cwd>' && ...` 前缀。
 *
 * 不直接 import useTerminalSession / sshStore：terminal→param-complete-client
 * 是单向依赖，反向 import 会形成模块环（completionInjection 被
 * useTerminalSession 引用），故统一走注册表。
 */

/** leafId → 本地 cwd（OSC 7 跟踪值，useTerminalSession 更新） */
const leafCwds = new Map<number, string>();

/** leafId → 远端 cwd getter（SSH leaf 挂载时注册，读 sshStore 最新值） */
const leafRemoteCwds = new Map<number, () => string | null>();

/** 注册/更新本地 leaf 的 cwd（OSC 7 回调处调用，null 时清除） */
export function setLeafCwd(leafId: number, cwd: string | null): void {
  if (cwd === null) leafCwds.delete(leafId);
  else leafCwds.set(leafId, cwd);
}

/** 读取本地 leaf 的 cwd（未注册/未知 → null，调用方让 carapace 继承进程目录） */
export function getLeafCwd(leafId: number): string | null {
  return leafCwds.get(leafId) ?? null;
}

/** 读取 leaf 的远端 cwd getter 并取当前值（未注册 → null） */
export function getLeafRemoteCwd(leafId: number): string | null {
  return leafRemoteCwds.get(leafId)?.() ?? null;
}

/** leafId → rustSessionId；值 null 表示该 leaf 当前无可用 SSH 会话 */
const leafSshSessions = new Map<number, number | null>();

/** 注册/注销 leaf 的 SSH 会话绑定（SSH leaf 挂载 effect 调用，卸载时传 null） */
export function setLeafSshSession(leafId: number, rustSessionId: number | null): void;
/** 带远端 cwd getter 的注册重载（挂载处有前端 session 引用时一并传入） */
export function setLeafSshSession(
  leafId: number,
  rustSessionId: number | null,
  remoteCwd: () => string | null,
): void;
export function setLeafSshSession(
  leafId: number,
  rustSessionId: number | null,
  remoteCwd?: () => string | null,
): void {
  if (rustSessionId === null) {
    leafSshSessions.delete(leafId);
    leafRemoteCwds.delete(leafId);
    return;
  }
  leafSshSessions.set(leafId, rustSessionId);
  if (remoteCwd) leafRemoteCwds.set(leafId, remoteCwd);
}

/** 读取 leaf 绑定的 rustSessionId（未注册或未连接 → null，调用方回退静态层） */
export function getLeafSshSession(leafId: number): number | null {
  return leafSshSessions.get(leafId) ?? null;
}

// ============================================================================
// 纯函数：转义 / 解析 / 命令构造 / 候选合并
// ============================================================================

/**
 * POSIX 单引号转义：任何字符串包成 '...'，内部单引号按 sh 惯例替换为 '\''
 * （关闭引号 → 转义单引号 → 重开引号）。单引号内 $ 与反引号不展开，天然防注入。
 */
export function escapeShSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * 宽容解析 carapace export 的 stdout（单行 JSON，形如
 * {"values":[{"value":"main","description":"...","tag":"..."}]}）。
 * 畸形输入（非 JSON / 缺 values / 候选缺 value）一律返回 []，不抛错。
 */
export function parseCarapaceJson(output: string): CarapaceCandidate[] {
  const text = output.trim();
  if (!text.startsWith('{')) return [];
  try {
    const data: unknown = JSON.parse(text);
    const values = (data as { values?: unknown }).values;
    if (!Array.isArray(values)) return [];
    const out: CarapaceCandidate[] = [];
    for (const v of values) {
      if (!v || typeof v !== 'object') continue;
      const value = (v as { value?: unknown }).value;
      if (typeof value !== 'string' || value === '') continue;
      const description = (v as { description?: unknown }).description;
      const tag = (v as { tag?: unknown }).tag;
      out.push({
        value,
        description: typeof description === 'string' ? description : '',
        tag: typeof tag === 'string' ? tag : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 构造远端 carapace 补全命令：
 *   cd '<cwd>' && ~/.local/bin/carapace <completer> export <tokens...> '<current>'
 * 所有词都做单引号转义（current 为空时传 ''——carapace 把最后一个参数
 * 视为正在输入的词，空串即"刚打完空格"）。stderr 丢弃避免干扰 stdout 解析。
 *
 * cwd：远端 shell 的当前目录（exec 通道默认在 home，动态候选如 git 分支
 * 会取错仓库 —— 必须显式 cd 到 OSC 7 跟踪的远端 cwd）。cwd 为 null 时不加前缀。
 */
export function buildRemoteCarapaceCommand(
  completer: string,
  tokens: string[],
  current: string,
  cwd?: string | null,
): string {
  // `export` 子命令是固定字面量，不转义（与任务约定的命令模板逐字一致；
  // completer/tokens/current 全部转义）
  const head = `${CARAPACE_REMOTE_PATH} ${escapeShSingleQuote(completer)} export`;
  const tail = [...tokens, current].map(escapeShSingleQuote);
  const body = `${head} ${tail.join(' ')} 2>/dev/null`;
  // cd 单独包一层转义（cwd 来自 OSC 7 路径，可能含空格）
  return cwd ? `cd ${escapeShSingleQuote(cwd)} && ${body}` : body;
}

/** 与 paramSuggest.ts 的 PREFIX_COMMANDS 对齐（该文件不导出且约束不改动，此处对齐一份） */
const PREFIX_COMMANDS = new Set([
  'sudo',
  'command',
  'env',
  'exec',
  'nohup',
  'time',
  'nix',
  'xargs',
]);

/**
 * 从输入行构造 param_complete 请求参数。
 *
 * tokens 约定【含命令名】（param_complete.rs 的接口约定，Rust 侧自行消费）；
 * sudo 等前缀命令跳过（与 parseCommandLine 的行为对齐）；尾随空格时
 * current 为空串（正在输入新 token）。
 */
export function buildParamRequest(prefix: string): {
  cmd: string;
  tokens: string[];
  current: string;
} {
  const trailingSpace = /\s+$/.test(prefix);
  const tokens = prefix.trimEnd().split(/\s+/).filter(Boolean);
  if (tokens.length > 0 && PREFIX_COMMANDS.has(tokens[0])) tokens.shift();
  const current = trailingSpace ? '' : (tokens[tokens.length - 1] ?? '');
  return { cmd: tokens[0] ?? '', tokens, current };
}

/**
 * 合并 carapace 动态候选与静态回退候选：
 *   - carapace 候选转 SuggestionResult（command=value, kind/source='arg'）
 *   - 按 value 去重，carapace 优先（动态值是真数据，静态值兜底）
 *   - 最多 8 条（与 suggestParams 的 limit 一致）
 */
export function mergeCandidates(
  carapace: readonly CarapaceCandidate[],
  fallback: readonly SuggestionResult[],
  options?: MergeOptions,
): SuggestionResult[] {
  const out: SuggestionResult[] = [];
  const seen = new Set<string>();
  for (const c of carapace) {
    if (!c.value || seen.has(c.value) || out.length >= 8) continue;
    seen.add(c.value);
    out.push({
      command: c.value,
      source: 'arg',
      kind: 'arg',
      // 中文说明优先（spec P2），无中文用 carapace 原始描述，再无则省略
      description: options?.zhDescription?.(c.value) ?? (c.description || undefined),
    });
  }
  for (const f of fallback) {
    if (seen.has(f.command) || out.length >= 8) continue;
    seen.add(f.command);
    out.push(f);
  }
  return out;
}

// ============================================================================
// SSH 远端：存在性检测（会话级缓存）+ 动态补全
// ============================================================================

/** 会话级缓存：rustSessionId → 是否已安装远端 carapace（避免每次按键都 exec） */
const remoteInstalledCache = new Map<number, boolean>();

/** 使缓存失效（安装成功后 / 调试时调用，下次检测重新 exec） */
export function invalidateRemoteCarapaceCache(sessionId: number): void {
  remoteInstalledCache.delete(sessionId);
}

/**
 * 检测远端 ~/.local/bin/carapace 是否存在（exec 通道，2s 超时）。
 * 结果缓存到会话级 Map；invoke 本身抛错（会话异常）不缓存，下次重试。
 */
export async function remoteCarapaceInstalled(sessionId: number): Promise<boolean> {
  const cached = remoteInstalledCache.get(sessionId);
  if (cached !== undefined) return cached;
  try {
    const r = await sshCommand(sessionId, CARAPACE_CHECK_CMD, 2);
    const installed = r.ok && r.output.includes(CARAPACE_YES_MARK);
    remoteInstalledCache.set(sessionId, installed);
    return installed;
  } catch (e) {
    console.warn('[param-complete] remoteCarapaceInstalled failed:', e);
    return false;
  }
}

/**
 * 远端动态参数补全：exec 远端 carapace export，返回候选；
 * 任何失败（未安装 / 超时 / 非零退出 / 空 output / 解析为空）返回 null，
 * 由调用方回退 Fig specs 静态层。
 *
 * cwd：远端 shell 当前目录（leaf 注册的 remoteCwd getter 取值，null 时不加 cd 前缀）。
 */
export async function remoteParamComplete(
  sessionId: number,
  completer: string,
  tokens: string[],
  current: string,
  cwd?: string | null,
): Promise<SuggestionResult[] | null> {
  try {
    const r = await sshCommand(
      sessionId,
      buildRemoteCarapaceCommand(completer, tokens, current, cwd),
      2,
    );
    if (!r.ok || r.exitCode !== 0 || !r.output.trim()) return null;
    const candidates = parseCarapaceJson(r.output);
    if (candidates.length === 0) return null;
    return mergeCandidates(candidates, []);
  } catch (e) {
    console.warn('[param-complete] remoteParamComplete failed:', e);
    return null;
  }
}

// ============================================================================
// SSH 远端：一键安装链路（T6，无弹窗设计）
// ============================================================================
//
// 顺序（mkdir 必须在上传前——SFTP 无法上传到不存在的目录）：
//   1. preparing   : exec mkdir -p ~/.local/bin && echo $HOME（顺便拿 home 拼绝对路径）
//   2. uploading   : invoke sftp_upload_file 上传本地 linux 二进制
//                    —— 该命令由 src-tauri param_complete.rs 提供（并行开发中），
//                       localPath 来自 carapace_linux_path 命令（打包资源内
//                       linux_amd64 二进制的绝对路径）。若后端最终命令名/签名
//                       不同，在 T7 集成时统一对齐。
//   3. configuring : exec chmod +x + --version 验证
//   4. done        : 失效存在性缓存 → 后续参数预测直接走远端

/**
 * 取本地 linux 二进制路径。该命令由 param_complete.rs 提供（并行开发中），
 * T7 集成时对齐；失败抛错由 installRemoteCarapace 统一降级。
 */
async function carapaceLinuxPath(): Promise<string> {
  return invoke<string>('carapace_linux_path');
}

/**
 * 一键安装远端 carapace（SFTP 上传打包内 linux 二进制 + chmod + 验证）。
 * 不弹任何 UI（进度经 onProgress 回调交给调用方渲染），失败返回 false。
 */
export async function installRemoteCarapace(
  sessionId: number,
  onProgress?: (stage: CarapaceInstallStage) => void,
): Promise<boolean> {
  try {
    // 步骤 1：远端建目录 + 拿 $HOME（SFTP 需要绝对路径，~ 不会被 sftp 协议展开）
    onProgress?.('preparing');
    const mkdir = await sshCommand(sessionId, CARAPACE_MKDIR_CMD, 10);
    if (!mkdir.ok || mkdir.exitCode !== 0) return false;
    const home = mkdir.output.trim();
    // home 取不到时退回 ~ 路径（Rust 侧 sftp_upload_file 可能支持展开，T7 对齐点）
    const remotePath = home
      ? `${home}/.local/bin/carapace`
      : CARAPACE_REMOTE_PATH;

    // 步骤 2：上传本地 linux 二进制（param_complete.rs / sftp_upload_file，并行开发中）
    onProgress?.('uploading');
    const localPath = await carapaceLinuxPath();
    await invoke('sftp_upload_file', { sessionId, localPath, remotePath });

    // 步骤 3：chmod + 验证（--version 成功退出才算装好）
    onProgress?.('configuring');
    const verify = await sshCommand(sessionId, CARAPACE_CONFIGURE_CMD, 15);
    if (!verify.ok || verify.exitCode !== 0) return false;

    // 步骤 4：失效缓存 + 完成
    invalidateRemoteCarapaceCache(sessionId);
    onProgress?.('done');
    return true;
  } catch (e) {
    // 后端命令未就绪 / 会话已断开 / 上传失败——静默降级，调用方按 false 渲染
    console.warn('[param-complete] installRemoteCarapace failed:', e);
    return false;
  }
}
