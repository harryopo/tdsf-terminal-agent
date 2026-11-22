import { describe, expect, it } from 'vitest';
import { COMMAND_LIST, getCommandZh } from './command-dictionary';

const ADDED_COMMANDS = [
  'nmcli',
  'nmtui',
  'networkctl',
  'resolvectl',
  'hostnamectl',
  'ethtool',
  'arping',
  'tracepath',
  'mtr',
  'nc',
  'nft',
  'lsblk',
  'blkid',
  'findmnt',
  'mountpoint',
  'fdisk',
  'parted',
  'swapon',
  'swapoff',
  'pkill',
  'pgrep',
  'pstree',
  'timeout',
  'watch',
  'readlink',
  'realpath',
  'dirname',
  'basename',
  'xargs',
  'jq',
  'yq',
  'split',
  'truncate',
  'getenforce',
  'setenforce',
  'sestatus',
  'semanage',
  'restorecon',
  'setfacl',
  'getfacl',
  'loginctl',
  'timedatectl',
  'fastfetch',
  'sftp',
  'podman',
];

describe('Linux command dictionary', () => {
  it('includes each added command once with a concise Chinese description', () => {
    for (const command of ADDED_COMMANDS) {
      const entries = COMMAND_LIST.filter((entry) => entry.command === command);
      expect(entries, command).toHaveLength(1);
      expect(getCommandZh(command), command).toBe(entries[0]?.zh);
      expect(Array.from(entries[0]?.zh ?? '').length, command).toBeLessThanOrEqual(30);
      expect(entries[0]?.zh, command).toMatch(/[\u3400-\u9fff]/);
    }
  });

  it('preserves existing entries and returns empty for unknown commands', () => {
    expect(getCommandZh('ls')).toBe('列出目录内容');
    expect(getCommandZh('git')).toBe('版本控制');
    expect(getCommandZh('tdsf-command-that-does-not-exist')).toBe('');
  });
});
