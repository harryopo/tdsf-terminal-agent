/**
 * remoteCarapaceEntry.test.ts — 「设置页那个入口」的接线、文案与数字闸
 * -----------------------------------------------------------------------------
 * 逻辑单测抓不到三类问题，都钉在这里：
 *   1. **实现了但没接上**（#125/#142 那一族）：卡片组件写了没挂进设置页 = 用户
 *      还是找不到；主窗没注册监听 = 装完图标仍挂着"未安装"。
 *   2. **文案说假事实**：这块界面存在的意义就是把"不装有什么、装了什么"讲清楚，
 *      退化成一句"远程补全提示"就等于没做。
 *   3. **界面里的体积数字会漂**：换一次 carapace 二进制，"约 80 MB"就是假话
 *      （#144：注释与文案里的承诺也是要验的资产）。
 *
 * 读源码用 `join(process.cwd(), ...)`：happy-dom 下 import.meta.url 不是 file:。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CARAPACE_BINARY_MB } from '@/settings/lib/remoteCarapaceAdmin';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('设置页入口的接线', () => {
  it('GeneralSection 真的挂了那张卡片（不是只写了组件）', () => {
    const src = read('src/settings/sections/GeneralSection.tsx');
    expect(src).toContain('import { RemoteCarapaceCard } from "./RemoteCarapaceCard"');
    expect(src).toContain('<RemoteCarapaceCard />');
  });

  it('卡片用的是逻辑层的三个入口，没在组件里另抄一遍 IPC', () => {
    const src = read('src/settings/sections/RemoteCarapaceCard.tsx');
    expect(src).toContain('listCarapaceTargets');
    expect(src).toContain('probeCarapaceTarget');
    expect(src).toContain('installCarapaceTarget');
    expect(src).not.toContain('@tauri-apps/api/core');
  });

  it('主窗入口注册了跨窗监听（设置窗不注册自己那份）', () => {
    const src = read('src/main.tsx');
    expect(src).toContain('ssh-explorer/lib/sshCarapaceSync');
    expect(src).toContain('initCarapaceSyncListener()');
    // 动态 import：不为一个监听把 sshStore 拉进 eager 启动包（eager-budget 拦这个）
    expect(src).toMatch(
      /import\("\.\/modules\/ssh-explorer\/lib\/sshCarapaceSync"\)\.then/,
    );
  });

  it('设置侧发、主窗侧收，同一个事件名常量（字面量全仓只许出现一次）', () => {
    const emitter = read('src/settings/lib/remoteCarapaceAdmin.ts');
    const listener = read('src/modules/ssh-explorer/lib/sshCarapaceSync.ts');
    expect(emitter).toContain("from '@/lib/sshCarapaceEvents'");
    expect(listener).toContain("from '@/lib/sshCarapaceEvents'");
    const owner = read('src/lib/sshCarapaceEvents.ts');
    expect(owner.match(/tdsf:ssh-carapace-changed/g)?.length).toBe(1);
  });

  it('事件常量模块不引任何重依赖（照 predictionEvents 的硬约束）', () => {
    const src = read('src/lib/sshCarapaceEvents.ts');
    expect(src).not.toMatch(/^import /m);
  });
});

describe('界面文案不许说假事实', () => {
  const general = read('src/settings/sections/GeneralSection.tsx');

  it('要说清"不装也有静态参数提示"（否则用户以为不装就完全没补全）', () => {
    expect(general).toContain('不装也照常提示静态参数');
    expect(general).toContain('真实存在的分支、文件名与服务名');
  });

  it('要说清开关只管图标、不管这块入口（两个东西不许糊成一句）', () => {
    expect(general).toContain('下面这块入口照样能装');
  });

  it('旧的含糊标题不再回来（"SSH 远程参数补全提示"没交代任何后果）', () => {
    expect(general).not.toContain('SSH 远程参数补全提示');
  });

  it('界面是纯文本渲染，这段说明里不许留 markdown 反引号', () => {
    // 只量这段用户看得见的正文：整份文件里有模板字符串的反引号，那是代码不是文案
    const start = general.indexOf('远端补全组件：');
    expect(start).toBeGreaterThan(-1);
    const prose = general.slice(start, general.indexOf('</span>', start));
    expect(prose).not.toContain('`');
    expect(prose).not.toMatch(/[A-Za-z]{4,}\s+模式|TODO/);
  });
});

describe('体积数字与真身对齐', () => {
  it('carapace 的 Linux 二进制实际大小仍在文案那个数附近', () => {
    const bytes = readFileSync(
      join(process.cwd(), 'src-tauri/bin/carapace-linux-amd64'),
    ).length;
    const actual = bytes / (1024 * 1024);
    // 允许 ±10 MB：二进制换版本会小幅浮动，浮动超出这个范围就说明文案该重读了
    expect(Math.abs(actual - CARAPACE_BINARY_MB)).toBeLessThanOrEqual(10);
  });
});
