/**
 * cmux-protocol.test.ts — JSON-lines 协议解析测试 (T-P2-11.5)
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. parseCmuxLine: 合法 / 非法 JSON / 缺 cmd / 非法 cmd
 *   2. serializeCmuxMessage: 序列化 / 特殊字符
 *   3. CmuxProtocolParser: 单行 / 多行 / 半行 / reset
 *   4. validateCmuxMessage: 未知命令 / 缺 args
 *   5. CMUX_COMMANDS: 10 命令完整识别
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseCmuxLine,
  serializeCmuxMessage,
  validateCmuxMessage,
  CmuxProtocolParser,
  CMUX_COMMANDS,
  type CmuxMessage,
} from './cmux-protocol';

describe('cmux-protocol — parseCmuxLine', () => {
  it('test_parse_valid_json: 合法 JSON 返回 CmuxMessage', () => {
    const line = '{"cmd":"split-v","args":{"target":"pane-1"}}';
    const msg = parseCmuxLine(line);
    expect(msg).not.toBeNull();
    expect(msg?.cmd).toBe('split-v');
    expect(msg?.args.target).toBe('pane-1');
  });

  it('test_parse_invalid_json_returns_null: 非法 JSON 返回 null', () => {
    expect(parseCmuxLine('not-json')).toBeNull();
    expect(parseCmuxLine('{broken')).toBeNull();
    expect(parseCmuxLine('')).toBeNull();
    expect(parseCmuxLine('   ')).toBeNull();
    // JSON 解析成功但结构非法也视为非法
    expect(parseCmuxLine('"just-a-string"')).toBeNull();
    expect(parseCmuxLine('123')).toBeNull();
    expect(parseCmuxLine('null')).toBeNull();
    expect(parseCmuxLine('[]')).toBeNull();
  });

  it('test_parse_missing_cmd_returns_null: 缺 cmd 字段返回 null', () => {
    expect(parseCmuxLine('{"args":{}}')).toBeNull();
    expect(parseCmuxLine('{"args":{"target":"pane-1"}}')).toBeNull();
    // cmd 为非 string 类型
    expect(parseCmuxLine('{"cmd":123,"args":{}}')).toBeNull();
    expect(parseCmuxLine('{"cmd":null,"args":{}}')).toBeNull();
  });

  it('test_parse_invalid_cmd_returns_null: 未知命令返回 null', () => {
    expect(parseCmuxLine('{"cmd":"unknown-cmd","args":{}}')).toBeNull();
    expect(parseCmuxLine('{"cmd":"split","args":{}}')).toBeNull();
    expect(parseCmuxLine('{"cmd":"SPLIT-V","args":{}}')).toBeNull(); // 大小写敏感
    expect(parseCmuxLine('{"cmd":"","args":{}}')).toBeNull();
  });
});

describe('cmux-protocol — serializeCmuxMessage', () => {
  it('test_serialize_message: 序列化消息为 JSON line', () => {
    const msg: CmuxMessage = { cmd: 'split-v', args: { target: 'pane-1' } };
    const line = serializeCmuxMessage(msg);
    expect(line).toBe('{"cmd":"split-v","args":{"target":"pane-1"}}');
    // 单行, 不含 \n
    expect(line.includes('\n')).toBe(false);
  });

  it('test_serialize_with_special_chars: 序列化含特殊字符的 name', () => {
    const msg: CmuxMessage = {
      cmd: 'rename',
      args: { target: 'pane-1', name: 'logs "quoted" 中文' },
    };
    const line = serializeCmuxMessage(msg);
    // 双引号被转义为 \"
    expect(line.includes('\\"quoted\\"')).toBe(true);
    // 中文 UTF-8 直接保留
    expect(line.includes('中文')).toBe(true);
    // 反向解析应得到等价消息
    const parsed = parseCmuxLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.cmd).toBe('rename');
    expect(parsed?.args.name).toBe('logs "quoted" 中文');
  });
});

describe('cmux-protocol — CmuxProtocolParser.feed', () => {
  let parser: CmuxProtocolParser;

  beforeEach(() => {
    parser = new CmuxProtocolParser();
  });

  it('test_parser_feed_single_line: 单行完整消息', () => {
    const msgs = parser.feed('{"cmd":"focus-next","args":{}}\n');
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.cmd).toBe('focus-next');
    expect(parser.pending()).toBe('');
  });

  it('test_parser_feed_multiple_lines: 多行批量消息', () => {
    const data = [
      '{"cmd":"split-v","args":{"target":"pane-1"}}',
      '{"cmd":"split-h","args":{"target":"pane-2"}}',
      '{"cmd":"focus-next","args":{}}',
    ].join('\n') + '\n';
    const msgs = parser.feed(data);
    expect(msgs.length).toBe(3);
    expect(msgs[0]?.cmd).toBe('split-v');
    expect(msgs[1]?.cmd).toBe('split-h');
    expect(msgs[2]?.cmd).toBe('focus-next');
  });

  it('test_parser_feed_partial_line: 半行累积后再补齐', () => {
    // 第一次 feed: 半行 (无 \n)
    const first = parser.feed('{"cmd":"focus-next","args":{}}');
    expect(first.length).toBe(0);
    expect(parser.pending()).toBe('{"cmd":"focus-next","args":{}}');

    // 第二次 feed: 补齐 \n
    const second = parser.feed('\n');
    expect(second.length).toBe(1);
    expect(second[0]?.cmd).toBe('focus-next');
    expect(parser.pending()).toBe('');
  });

  it('test_parser_feed_partial_line_split_multiple: 一行被切成 3 段', () => {
    const a = parser.feed('{"cmd":"');
    expect(a.length).toBe(0);
    const b = parser.feed('close","args":');
    expect(b.length).toBe(0);
    const c = parser.feed('{"target":"pane-1"}}\n');
    expect(c.length).toBe(1);
    expect(c[0]?.cmd).toBe('close');
    expect(c[0]?.args.target).toBe('pane-1');
  });

  it('test_parser_feed_invalid_lines_skipped: 非法行被跳过, 不影响其他合法行', () => {
    const data = [
      '{"cmd":"split-v","args":{}}',  // 合法
      'not-json-line',                 // 非法 → 跳过
      '{"cmd":"bad","args":{}}',       // 未知命令 → 跳过
      '',                              // 空行 → 跳过
      '{"cmd":"new-tab","args":{}}',   // 合法
    ].join('\n') + '\n';
    const msgs = parser.feed(data);
    expect(msgs.length).toBe(2);
    expect(msgs[0]?.cmd).toBe('split-v');
    expect(msgs[1]?.cmd).toBe('new-tab');
  });

  it('test_parser_reset: reset 清空 buffer', () => {
    parser.feed('{"cmd":"focus-next","args":{}}'); // 半行, 无 \n
    expect(parser.pending()).toBe('{"cmd":"focus-next","args":{}}');

    parser.reset();
    expect(parser.pending()).toBe('');

    // reset 后再喂入完整行应能正常解析
    const msgs = parser.feed('{"cmd":"new-tab","args":{}}\n');
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.cmd).toBe('new-tab');
  });

  it('test_parser_feed_crlf: 支持 \\r\\n 行尾 (Windows)', () => {
    const msgs = parser.feed('{"cmd":"split-v","args":{}}\r\n{"cmd":"new-tab","args":{}}\r\n');
    expect(msgs.length).toBe(2);
    expect(msgs[0]?.cmd).toBe('split-v');
    expect(msgs[1]?.cmd).toBe('new-tab');
  });

  it('test_parser_feed_empty_string: 空字符串返回空数组', () => {
    expect(parser.feed('')).toEqual([]);
    expect(parser.feed('   ')).toEqual([]);
  });
});

describe('cmux-protocol — validateCmuxMessage', () => {
  it('test_validate_unknown_command: 未知命令返回 null', () => {
    expect(validateCmuxMessage({ cmd: 'teleport', args: {} })).toBeNull();
    expect(validateCmuxMessage({ cmd: '', args: {} })).toBeNull();
  });

  it('test_validate_missing_args: 缺 args 字段返回 null', () => {
    expect(validateCmuxMessage({ cmd: 'split-v' })).toBeNull();
    expect(validateCmuxMessage({ cmd: 'split-v', args: null })).toBeNull();
    expect(validateCmuxMessage({ cmd: 'split-v', args: [] })).toBeNull();
    expect(validateCmuxMessage({ cmd: 'split-v', args: 'not-object' })).toBeNull();
  });

  it('test_validate_args_type_check: args 字段类型错误返回 null', () => {
    // target 必须为 string
    expect(
      validateCmuxMessage({ cmd: 'close', args: { target: 123 } }),
    ).toBeNull();
    // name 必须为 string
    expect(
      validateCmuxMessage({ cmd: 'rename', args: { name: 99 } }),
    ).toBeNull();
    // index 必须为 number
    expect(
      validateCmuxMessage({ cmd: 'select-tab', args: { index: '2' } }),
    ).toBeNull();
    // index 不能为 NaN
    expect(
      validateCmuxMessage({ cmd: 'select-tab', args: { index: NaN } }),
    ).toBeNull();
  });

  it('test_validate_all_args_optional: args 内所有字段可选, 空对象合法', () => {
    const msg = validateCmuxMessage({ cmd: 'focus-next', args: {} });
    expect(msg).not.toBeNull();
    expect(msg?.cmd).toBe('focus-next');
    expect(msg?.args.target).toBeUndefined();
    expect(msg?.args.name).toBeUndefined();
    expect(msg?.args.index).toBeUndefined();
  });

  it('test_validate_non_object_input: 非对象输入返回 null', () => {
    expect(validateCmuxMessage(null)).toBeNull();
    expect(validateCmuxMessage(undefined)).toBeNull();
    expect(validateCmuxMessage('string')).toBeNull();
    expect(validateCmuxMessage(123)).toBeNull();
    expect(validateCmuxMessage([1, 2, 3])).toBeNull();
  });
});

describe('cmux-protocol — CMUX_COMMANDS 常量', () => {
  it('test_all_10_commands_recognized: 10 个命令全部识别', () => {
    expect(CMUX_COMMANDS.length).toBe(10);

    // 每个命令都能被 parseCmuxLine 识别
    for (const cmd of CMUX_COMMANDS) {
      const line = JSON.stringify({ cmd, args: {} });
      const msg = parseCmuxLine(line);
      expect(msg, `命令 ${cmd} 应被识别`).not.toBeNull();
      expect(msg?.cmd).toBe(cmd);
    }
  });

  it('test_commands_unique: 命令不重复', () => {
    const set = new Set(CMUX_COMMANDS);
    expect(set.size).toBe(CMUX_COMMANDS.length);
  });

  it('test_commands_order: 命令顺序固定 (分屏 → 焦点 → 关闭 → 重命名 → 滚动 → tab)', () => {
    expect(CMUX_COMMANDS).toEqual([
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
    ]);
  });
});
