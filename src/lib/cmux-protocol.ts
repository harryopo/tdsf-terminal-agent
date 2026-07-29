/**
 * cmux-protocol.ts — cmux-tui JSON-lines 控制协议子集 (T-P2-11.1)
 * -----------------------------------------------------------------------------
 * 协议规范 (每行一个完整 JSON 对象, UTF-8 编码, \n 分隔):
 *   {"cmd": "split-v", "args": {"target": "pane-1"}}
 *   {"cmd": "focus-next", "args": {}}
 *   {"cmd": "close", "args": {"target": "pane-1"}}
 *   {"cmd": "rename", "args": {"target": "pane-1", "name": "logs"}}
 *   {"cmd": "select-tab", "args": {"index": 2}}
 *
 * 10 命令清单:
 *   split-v     垂直分屏 (左右二分)
 *   split-h     水平分屏 (上下二分)
 *   focus-next  切换到下一个 pane
 *   focus-prev  切换到上一个 pane
 *   close       关闭指定 pane
 *   rename      重命名 pane
 *   scroll-up   向上滚动
 *   scroll-down 向下滚动
 *   select-tab  切换到指定 tab
 *   new-tab     新建 tab
 *
 * 设计原则:
 *   1. 容错解析: 任何非法 JSON / 结构不合法均返回 null, 不抛异常
 *   2. 流式解析: CmuxProtocolParser 支持分片到达 (TCP/PTY 场景)
 *   3. 严格类型: TypeScript 严格模式 + 联合类型穷举
 *   4. 零依赖: 纯 TypeScript, 不引入第三方库
 */
'use strict';

// === 1. 类型定义 =============================================================

/**
 * cmux 协议命令枚举 (10 个, 联合类型穷举)
 * 顺序与 CMUX_COMMANDS 常量保持一致
 */
export type CmuxCommand =
  | 'split-v' // 垂直分屏 (左右二分)
  | 'split-h' // 水平分屏 (上下二分)
  | 'focus-next' // 切换到下一个 pane
  | 'focus-prev' // 切换到上一个 pane
  | 'close' // 关闭指定 pane
  | 'rename' // 重命名 pane
  | 'scroll-up' // 向上滚动
  | 'scroll-down' // 向下滚动
  | 'select-tab' // 切换到指定 tab
  | 'new-tab'; // 新建 tab

/**
 * cmux 消息参数
 * - target: 目标 pane ID (close/rename/focus 等使用)
 * - name:   新名称 (rename 使用)
 * - index:  tab 索引 (select-tab 使用, 0-based)
 */
export interface CmuxMessageArgs {
  target?: string;
  name?: string;
  index?: number;
}

/**
 * cmux 协议消息 (一行 JSON 对应一个 CmuxMessage)
 */
export interface CmuxMessage {
  cmd: CmuxCommand;
  args: CmuxMessageArgs;
}

// === 2. 常量 =================================================================

/**
 * 10 个命令的常量数组 (用于运行时校验 + UI 遍历)
 * 顺序: 分屏 → 焦点 → 关闭 → 重命名 → 滚动 → tab
 */
export const CMUX_COMMANDS: readonly CmuxCommand[] = [
  'split-v',
  'split-h',
  'focus-next',
  'focus-prev',
  'close',
  'rename',
  'scroll-up',
  'scroll-down',
  'select-tab',
  'new-tab',
] as const;

/** 命令集合 (Set 用于 O(1) 查重) */
const CMUX_COMMAND_SET: ReadonlySet<string> = new Set<string>(CMUX_COMMANDS);

// === 3. 解析 / 序列化 / 校验 ================================================

/**
 * 解析单行 JSON 为 CmuxMessage
 * - 合法返回 CmuxMessage, 非法返回 null
 * - 容错: JSON.parse 异常 / 结构不合法均返回 null, 不抛异常
 *
 * @param line 单行 JSON 字符串 (前后空白允许, 但内部不能含 \n)
 * @returns CmuxMessage | null
 */
export function parseCmuxLine(line: string): CmuxMessage | null {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return validateCmuxMessage(obj);
}

/**
 * 序列化 CmuxMessage 为 JSON line (单行, 末尾不含 \n)
 * - 输出可作为 JSON-lines 协议的一行
 *
 * @param msg CmuxMessage
 * @returns JSON 字符串 (单行)
 */
export function serializeCmuxMessage(msg: CmuxMessage): string {
  return JSON.stringify(msg);
}

/**
 * 校验未知对象是否为合法的 CmuxMessage
 * - 必须是对象 (非 null)
 * - 必须有 cmd 字段 (string, 在 10 命令集合内)
 * - 必须有 args 字段 (object, 非 null, 非 array)
 * - args.target / args.name 必须为 string (若存在)
 * - args.index 必须为 number (若存在)
 *
 * @param msg 未知值
 * @returns CmuxMessage | null
 */
export function validateCmuxMessage(msg: unknown): CmuxMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;

  // cmd: 必须是已知命令
  if (typeof m.cmd !== 'string' || !CMUX_COMMAND_SET.has(m.cmd)) {
    return null;
  }

  // args: 必须存在且为纯对象 (非 null, 非 array)
  if (typeof m.args !== 'object' || m.args === null || Array.isArray(m.args)) {
    return null;
  }
  const a = m.args as Record<string, unknown>;

  // args.target: 可选, 必须为 string
  if (a.target !== undefined && typeof a.target !== 'string') {
    return null;
  }
  // args.name: 可选, 必须为 string
  if (a.name !== undefined && typeof a.name !== 'string') {
    return null;
  }
  // args.index: 可选, 必须为 number (NaN 视为非法)
  if (a.index !== undefined) {
    if (typeof a.index !== 'number' || Number.isNaN(a.index)) {
      return null;
    }
  }

  const args: CmuxMessageArgs = {};
  if (a.target !== undefined) args.target = a.target;
  if (a.name !== undefined) args.name = a.name;
  if (a.index !== undefined) args.index = a.index;

  return { cmd: m.cmd as CmuxCommand, args };
}

// === 4. 流式解析器 ===========================================================

/**
 * CmuxProtocolParser — 流式 JSON-lines 解析器
 * -----------------------------------------------------------------------------
 * 适用场景:
 *   - 数据分片到达 (TCP/PTY/WebSocket 拆包)
 *   - 一次喂入多行 (批量)
 *   - 一行跨多次 feed (碎片)
 *
 * 算法:
 *   1. 累积 buffer, 按 \n 切分
 *   2. 完整行 (有 \n 结尾) 立即解析并加入结果
 *   3. 残余 (无 \n) 保留在 buffer 等待下次 feed
 *   4. \r\n 与 \n 均支持 (trim 处理)
 *   5. 空行跳过 (不报错)
 *   6. 非法行跳过 (不抛异常, 不影响其他行)
 */
export class CmuxProtocolParser {
  /** 内部缓冲区 (保留未完成行的原始字节) */
  private buffer: string = '';

  /**
   * 喂入数据, 返回所有完整解析的 CmuxMessage
   * - 多行输入: 返回多个消息 (按顺序)
   * - 半行输入: 返回 [] (等待下次 feed)
   * - 非法行: 跳过, 不影响其他行
   *
   * @param data 字符串数据 (可包含多行 / 半行)
   * @returns 解析出的 CmuxMessage 数组 (可能为空)
   */
  feed(data: string): CmuxMessage[] {
    if (typeof data !== 'string' || data.length === 0) return [];

    this.buffer += data;
    const messages: CmuxMessage[] = [];

    // 按 \n 切分, 逐行处理
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);

      const trimmed = line.trim();
      if (trimmed.length === 0) continue; // 空行跳过

      const msg = parseCmuxLine(trimmed);
      if (msg !== null) {
        messages.push(msg);
      }
      // 非法行静默丢弃
    }

    return messages;
  }

  /**
   * 重置解析器状态 (清空 buffer)
   * - 用于连接断开 / 切换会话等场景
   */
  reset(): void {
    this.buffer = '';
  }

  /**
   * 返回当前 buffer 中未完成的内容 (调试用)
   */
  pending(): string {
    return this.buffer;
  }
}
