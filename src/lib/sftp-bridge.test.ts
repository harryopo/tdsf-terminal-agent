/**
 * sftp-bridge.test.ts — SFTP 桥接层单元测试 (T-P2-05)
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. SFTP invoke 命令调用参数正确性 (sftpList/Read/Write/Mkdir/Remove/Rename/Stat)
 *   2. Vec<u8> ↔ Uint8Array 序列化/反序列化
 *   3. decodeUtf8 / encodeUtf8 纯函数 (含中文 + 边界情况)
 *   4. 错误传播 (invoke 抛错时 SFTP 函数也抛错)
 *
 * Mock 策略:
 *   - vi.mock('@tauri-apps/api/core') 替换 invoke 为 vi.fn()
 *   - 每个测试用例通过 mockReturnValue/mockRejectedValue 控制返回值
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// === Mock @tauri-apps/api/core 的 invoke ====================================
// 必须在 import sftp-bridge 之前,因为 sftp-bridge 在顶层 import { invoke }
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// 在 mock 之后 import sftp-bridge,确保使用 mock 后的 invoke
import {
  sftpList,
  sftpStat,
  sftpRead,
  sftpWrite,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  decodeUtf8,
  encodeUtf8,
  type SftpEntry,
} from './sftp-bridge';
import { invoke } from '@tauri-apps/api/core';

// === 测试数据 ================================================================
const SESSION_ID = 42;
const SAMPLE_ENTRIES: SftpEntry[] = [
  {
    name: 'nginx.conf',
    path: '/etc/nginx/nginx.conf',
    isDir: false,
    isFile: true,
    isSymlink: false,
    size: 1024,
    modified: 1700000000,
    permissions: 'rw-r--r--',
  },
  {
    name: 'sites-enabled',
    path: '/etc/nginx/sites-enabled',
    isDir: true,
    isFile: false,
    isSymlink: false,
    size: 0,
    modified: 1700000001,
    permissions: 'rwxr-xr-x',
  },
  {
    name: '中文目录',
    path: '/etc/nginx/中文目录',
    isDir: true,
    isFile: false,
    isSymlink: false,
    size: 0,
    modified: 1700000002,
    permissions: 'rwxr-xr-x',
  },
];

beforeEach(() => {
  // 每个测试前重置 mock
  vi.mocked(invoke).mockReset();
});

// === 测试用例 ================================================================

describe('sftp-bridge', () => {
  // ==========================================================================
  // 1. sftpList — 列目录
  // ==========================================================================
  describe('sftpList', () => {
    it('调用 sftp_list 命令并返回 SftpEntry[]', async () => {
      vi.mocked(invoke).mockResolvedValue(SAMPLE_ENTRIES);

      const result = await sftpList(SESSION_ID, '/etc/nginx');

      expect(invoke).toHaveBeenCalledWith('sftp_list', {
        sessionId: SESSION_ID,
        path: '/etc/nginx',
      });
      expect(result).toEqual(SAMPLE_ENTRIES);
      expect(result.length).toBe(3);
    });

    it('支持中文路径', async () => {
      vi.mocked(invoke).mockResolvedValue([]);

      await sftpList(SESSION_ID, '/home/user/中文目录');

      expect(invoke).toHaveBeenCalledWith('sftp_list', {
        sessionId: SESSION_ID,
        path: '/home/user/中文目录',
      });
    });

    it('空目录返回空数组', async () => {
      vi.mocked(invoke).mockResolvedValue([]);

      const result = await sftpList(SESSION_ID, '/empty');

      expect(result).toEqual([]);
      expect(result.length).toBe(0);
    });

    it('invoke 抛错时传播错误', async () => {
      const errorMsg = 'SFTP server closed connection';
      vi.mocked(invoke).mockRejectedValue(new Error(errorMsg));

      await expect(sftpList(SESSION_ID, '/')).rejects.toThrow(errorMsg);
    });
  });

  // ==========================================================================
  // 2. sftpStat — 查询文件属性
  // ==========================================================================
  describe('sftpStat', () => {
    it('调用 sftp_stat 命令并返回 SftpAttrs', async () => {
      const attrs = {
        size: 2048,
        uid: 1000,
        gid: 1000,
        permissions: 420, // 0o644
        modified: 1700000000,
        accessed: 1700000001,
      };
      vi.mocked(invoke).mockResolvedValue(attrs);

      const result = await sftpStat(SESSION_ID, '/etc/passwd');

      expect(invoke).toHaveBeenCalledWith('sftp_stat', {
        sessionId: SESSION_ID,
        path: '/etc/passwd',
      });
      expect(result).toEqual(attrs);
      expect(result.size).toBe(2048);
    });
  });

  // ==========================================================================
  // 3. sftpRead — 读取文件 (Vec<u8> → Uint8Array)
  // ==========================================================================
  describe('sftpRead', () => {
    it('调用 sftp_read 并返回 Uint8Array', async () => {
      // Rust Vec<u8> 序列化为 number[]
      const binaryData = [72, 101, 108, 108, 111]; // "Hello"
      vi.mocked(invoke).mockResolvedValue(binaryData);

      const result = await sftpRead(SESSION_ID, '/tmp/test.txt');

      expect(invoke).toHaveBeenCalledWith('sftp_read', {
        sessionId: SESSION_ID,
        path: '/tmp/test.txt',
      });
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(5);
      expect(Array.from(result)).toEqual(binaryData);
    });

    it('空文件返回空 Uint8Array', async () => {
      vi.mocked(invoke).mockResolvedValue([]);

      const result = await sftpRead(SESSION_ID, '/tmp/empty');

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
    });

    it('二进制数据正确转换', async () => {
      // 0-255 全字节范围
      const binaryData = Array.from({ length: 256 }, (_, i) => i);
      vi.mocked(invoke).mockResolvedValue(binaryData);

      const result = await sftpRead(SESSION_ID, '/tmp/binary');

      expect(result.length).toBe(256);
      expect(result[0]).toBe(0);
      expect(result[255]).toBe(255);
    });
  });

  // ==========================================================================
  // 4. sftpWrite — 写入文件 (Uint8Array → number[])
  // ==========================================================================
  describe('sftpWrite', () => {
    it('调用 sftp_write 并将 Uint8Array 转换为 number[]', async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);
      const content = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"

      await sftpWrite(SESSION_ID, '/tmp/test.txt', content);

      expect(invoke).toHaveBeenCalledWith('sftp_write', {
        sessionId: SESSION_ID,
        path: '/tmp/test.txt',
        content: Array.from(content),
      });
    });

    it('空 Uint8Array 也能写入', async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);
      const content = new Uint8Array(0);

      await sftpWrite(SESSION_ID, '/tmp/empty', content);

      expect(invoke).toHaveBeenCalledWith('sftp_write', {
        sessionId: SESSION_ID,
        path: '/tmp/empty',
        content: [],
      });
    });

    it('写入失败时抛错', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('Permission denied'));
      const content = new Uint8Array([1, 2, 3]);

      await expect(
        sftpWrite(SESSION_ID, '/root/forbidden', content),
      ).rejects.toThrow('Permission denied');
    });
  });

  // ==========================================================================
  // 5. sftpMkdir / sftpRemove / sftpRename
  // ==========================================================================
  describe('sftpMkdir', () => {
    it('调用 sftp_mkdir 命令', async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);

      await sftpMkdir(SESSION_ID, '/tmp/new-dir');

      expect(invoke).toHaveBeenCalledWith('sftp_mkdir', {
        sessionId: SESSION_ID,
        path: '/tmp/new-dir',
      });
    });
  });

  describe('sftpRemove', () => {
    it('调用 sftp_remove 命令', async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);

      await sftpRemove(SESSION_ID, '/tmp/to-delete');

      expect(invoke).toHaveBeenCalledWith('sftp_remove', {
        sessionId: SESSION_ID,
        path: '/tmp/to-delete',
      });
    });
  });

  describe('sftpRename', () => {
    it('调用 sftp_rename 命令 (from → to)', async () => {
      vi.mocked(invoke).mockResolvedValue(undefined);

      await sftpRename(SESSION_ID, '/tmp/old', '/tmp/new');

      expect(invoke).toHaveBeenCalledWith('sftp_rename', {
        sessionId: SESSION_ID,
        from: '/tmp/old',
        to: '/tmp/new',
      });
    });
  });

  // ==========================================================================
  // 6. decodeUtf8 / encodeUtf8 — 纯函数
  // ==========================================================================
  describe('decodeUtf8', () => {
    it('解码 ASCII 文本', () => {
      const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      expect(decodeUtf8(bytes)).toBe('Hello');
    });

    it('解码 UTF-8 中文', () => {
      // "你好" 的 UTF-8 编码: E4 BD A0 E5 A5 BD
      const bytes = new Uint8Array([0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd]);
      expect(decodeUtf8(bytes)).toBe('你好');
    });

    it('解码空 Uint8Array 返回空字符串', () => {
      expect(decodeUtf8(new Uint8Array(0))).toBe('');
    });

    it('解码多字节 emoji', () => {
      // "🚀" 的 UTF-8 编码: F0 9F 9A 80
      const bytes = new Uint8Array([0xf0, 0x9f, 0x9a, 0x80]);
      expect(decodeUtf8(bytes)).toBe('🚀');
    });

    it('非法 UTF-8 字节不抛错 (fatal: false)', () => {
      // 单独的高位字节 0xFF 不是合法 UTF-8 起始字节
      const bytes = new Uint8Array([0xff, 0xfe]);
      // 不抛错, 返回替换字符 (U+FFFD) 或空字符串
      const result = decodeUtf8(bytes);
      expect(typeof result).toBe('string');
    });
  });

  describe('encodeUtf8', () => {
    it('编码 ASCII 文本', () => {
      const bytes = encodeUtf8('Hello');
      expect(Array.from(bytes)).toEqual([72, 101, 108, 108, 111]);
    });

    it('编码 UTF-8 中文', () => {
      const bytes = encodeUtf8('你好');
      expect(Array.from(bytes)).toEqual([0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd]);
    });

    it('编码空字符串返回空 Uint8Array', () => {
      const bytes = encodeUtf8('');
      expect(bytes.length).toBe(0);
    });

    it('编码 emoji', () => {
      const bytes = encodeUtf8('🚀');
      expect(Array.from(bytes)).toEqual([0xf0, 0x9f, 0x9a, 0x80]);
    });

    it('encode → decode 往返一致 (round-trip)', () => {
      const original = 'Hello 世界 🚀 - 中文测试';
      const bytes = encodeUtf8(original);
      const decoded = decodeUtf8(bytes);
      expect(decoded).toBe(original);
    });
  });

  // ==========================================================================
  // 7. SftpEntry 类型字段完整性
  // ==========================================================================
  describe('SftpEntry 类型', () => {
    it('包含所有必要字段', () => {
      const entry: SftpEntry = {
        name: 'test.txt',
        path: '/tmp/test.txt',
        isDir: false,
        isFile: true,
        isSymlink: false,
        size: 100,
        modified: 1700000000,
        permissions: 'rw-r--r--',
      };
      expect(entry.name).toBe('test.txt');
      expect(entry.path).toBe('/tmp/test.txt');
      expect(entry.isDir).toBe(false);
      expect(entry.isFile).toBe(true);
      expect(entry.isSymlink).toBe(false);
      expect(entry.size).toBe(100);
      expect(entry.modified).toBe(1700000000);
      expect(entry.permissions).toBe('rw-r--r--');
    });
  });
});
