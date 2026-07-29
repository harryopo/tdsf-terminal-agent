/**
 * ssh/randomart.ts — OpenSSH 艺术指纹生成器（TDSF 魔改 2026-07-28）
 * ============================================================
 *
 * 生成 OpenSSH 风格的 ASCII randomart（ssh-keygen -lv 输出的图案）。
 * 用于在 SSH 主机审批对话框中更直观地展示密钥指纹。
 *
 * 算法来自 OpenSSH 源码（authfd.c / sshkey.c）中的
 * `fingerprint_randomart` 函数：Drijvers et al. 2012 的
 * "Hedgehog" 哈希可视化。
 *
 * 原理：
 * 1. 取输入字节（hex fingerprint 转回 bytes）作为起点
 * 2. 在 17x9 网格上从中心开始"游走"，每字节 2 步（高 4 位 + 低 4 位）
 * 3. 每步向 4 邻域之一移动，累加该格计数
 * 4. 起点 = 'S'（Start），终点 = 'E'（End），其他用 .o+=*BOX@%&#/^SE
 *
 * 视觉示例（OpenSSH 输出）：
 * ```
 * +--[RSA 2048]--+
 * |  ..o.+       |
 * |   o.o.=      |
 * |  o  .+o      |
 * | . o. .o      |
 * |  * o.S .     |
 * | . = o .      |
 * |  o + o       |
 * |   . =        |
 * |    E         |
 * +--------------+
 * ```
 */

const GRID_W = 17;
const GRID_H = 9;
const CELL_COUNT = GRID_W * GRID_H;

const X = Math.floor(GRID_W / 2); // 8
const Y = Math.floor(GRID_H / 2); // 4

/**
 * OpenSSH 字符表（共 18 个字符）：
 * 0='.' 1='o' 2='+' 3='=' 4='*' 5='B' 6='O' 7='X' 8='@'
 * 9='%' 10='&' 11='#' 12='/' 13='^' 14='S' 15='E' 16=' ' 17='\n'
 */
const CHARS = ".o+=*BOX@%&#/^S";

/**
 * hex fingerprint 字符串 → byte array
 * 兼容以下输入:
 *   - "SHA256:abc123..."  (OpenSSH base64 形式, 仅剥前缀, 不删除内部 :)
 *   - "ab:cd:ef:12"       (纯 hex with colons, 整串就是 hex 字节)
 *
 * 关键判断: SHA256 等 OpenSSH 命名指纹的 base64 部分**不含 ":"**.
 * 因此 "ALGO:rest" 形式只要 rest 还有 ":" 就不是 OpenSSH 命名形式,
 * 整串都按 hex with colons 解析.
 */
export function fingerprintToBytes(fingerprint: string): Uint8Array {
  if (!fingerprint) return new Uint8Array();

  let payload = fingerprint;
  // 1. 尝试识别 OpenSSH 命名指纹: "ALGO:rest"
  //    知名算法: MD5, SHA1, SHA256, SHA512, RIPEMD160
  const algoMatch = /^(MD5|SHA1|SHA256|SHA512|RIPEMD160):/i.exec(fingerprint);
  if (algoMatch) {
    const algoPrefix = algoMatch[0];
    const after = fingerprint.slice(algoPrefix.length);
    // 如果去除前缀后还有 ":", 不是 OpenSSH 命名形式 (不太可能, 防御性检查)
    if (!after.includes(":")) {
      payload = after; // SHA256 等 base64 形式, 直接给后面的 hex 处理
    }
  }
  // 若 prefix 匹配到但 after 仍含 :, 整串视作 hex with colons (payload 保持原值)

  // 2. 移除所有 : 和空白
  const hex = payload.replace(/[:\s]/g, "").replace(/[^0-9a-fA-F]/g, "");
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    const slice = hex.slice(i * 2, i * 2 + 2);
    bytes[i] = parseInt(slice, 16);
  }
  return bytes;
}

/**
 * 生成 OpenSSH 风格 randomart
 *
 * @param fingerprint 指纹字符串（hex 形式）
 * @param keyType 密钥类型（如 "ssh-ed25519" / "ssh-rsa"）
 * @returns 多行字符串（含顶/底边框）
 */
export function generateRandomArt(
  fingerprint: string,
  keyType: string = "ssh-ed25519",
): string {
  const bytes = fingerprintToBytes(fingerprint);
  if (bytes.length === 0) {
    return `+--[${truncateKeyType(keyType)}]--+`;
  }

  // 1. 初始化网格
  const grid = new Uint8Array(CELL_COUNT); // 计数
  const charGrid = new Array<string>(CELL_COUNT).fill(" ");
  let x = X;
  let y = Y;
  charGrid[y * GRID_W + x] = "S"; // 起点

  // 2. 游走
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    // 高 4 位 → 上下
    const dy = (b >> 4) & 0x0f;
    // 低 4 位 → 左右
    const dx = b & 0x0f;
    // 拆分 dx 为 2 步（保持对称性）
    const dx1 = (dx >> 2) & 0x03;
    const dy1 = (dx >> 0) & 0x03;
    // step 1
    x = clamp(x + dx1 - 1, 0, GRID_W - 1);
    y = clamp(y + dy1 - 1, 0, GRID_H - 1);
    grid[y * GRID_W + x]++;
    charGrid[y * GRID_W + x] = charForCount(grid[y * GRID_W + x]);
    // step 2
    const dx2 = (dy >> 2) & 0x03;
    const dy2 = (dy >> 0) & 0x03;
    x = clamp(x + dx2 - 1, 0, GRID_W - 1);
    y = clamp(y + dy2 - 1, 0, GRID_H - 1);
    grid[y * GRID_W + x]++;
    charGrid[y * GRID_W + x] = charForCount(grid[y * GRID_W + x]);
  }

  // 3. 标记终点
  charGrid[y * GRID_W + x] = "E";

  // 4. 渲染 (OpenSSH 标准格式: +--[LABEL]+ 顶 / 同样宽度的 +---+ 底)
  const label = truncateKeyType(keyType);
  const inner = `[${label}]`;
  const top = `+--${inner}+`; // 形如 +--[ecdsa-sha2-...]+ (label 16 字符固定)
  const bottom = `+${"-".repeat(top.length - 2)}+`;
  const lines: string[] = [top];
  for (let row = 0; row < GRID_H; row++) {
    const start = row * GRID_W;
    const line = charGrid.slice(start, start + GRID_W).join("");
    lines.push(`|${line}|`);
  }
  lines.push(bottom);
  return lines.join("\n");
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function charForCount(count: number): string {
  // OpenSSH 字符表（18 个），count 越大字符越"满"
  if (count <= 0) return " ";
  if (count >= CHARS.length) return "#";
  return CHARS[count] ?? " ";
}

function truncateKeyType(keyType: string): string {
  // OpenSSH 标签最长保留 16 字符 (含 '...')
  // 长于 16 字符的截断策略: 保留前 N 字符 + '...', 总长 16
  if (keyType.length <= 16) return keyType;
  return `${keyType.slice(0, 13)}...`; // 13 + 3 = 16
}

/**
 * 简化指纹：长串（> 12 字符）每 4 字符插入空格，便于人眼阅读
 * MD5/colon 形式原样保留
 */
export function formatFingerprint(fp: string): string {
  if (!fp) return "";
  const clean = fp.replace(/\s/g, "");
  if (clean.includes(":")) {
    return clean; // MD5 ab:cd:ef 形式不动
  }
  if (clean.length <= 12) return clean;
  return clean.match(/.{1,4}/g)?.join(" ") ?? clean;
}
