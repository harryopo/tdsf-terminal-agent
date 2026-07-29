/**
 * ThemePreview.tsx — P0 阶段样式系统验收页
 * -----------------------------------------------------------------------------
 * 展示内容:
 *   - 主题切换器 (15 内置)
 *   - 7 状态 Mood Ring
 *   - 5 档风险段条
 *   - 字体/字号/间距/圆角/阴影样例
 *   - 终端模拟 (用 terminal-* 颜色)
 *
 * 数据真实, 演示时给评审展示样式系统全貌.
 */
import { useState, type Dispatch, type SetStateAction } from 'react';
import { Moon, Sun, AlertTriangle, Check, X, Loader2, Circle } from 'lucide-react';

interface ThemePreviewProps {
  themes: readonly string[];
  currentTheme: string;
  onThemeChange: Dispatch<SetStateAction<string>>;
}

const MOOD_STATES = [
  { name: 'idle', label: 'Idle 闲置', desc: 'Agent 待命中, 呼吸光晕' },
  { name: 'thinking', label: 'Thinking 思考', desc: '紫罗兰三点波动' },
  { name: 'stream', label: 'Stream 流式', desc: '青色光标波动' },
  { name: 'working', label: 'Working 执行', desc: '琥珀色旋转' },
  { name: 'waiting', label: 'Waiting 等待', desc: '黄色脉冲环' },
  { name: 'done', label: 'Done 完成', desc: '翠绿闪烁' },
  { name: 'error', label: 'Error 错误', desc: '红色摇晃' },
] as const;

const RISK_LEVELS = [
  { name: 'L0', label: 'Safe', color: 'var(--color-risk-safe)', desc: '静默执行' },
  { name: 'L1', label: 'Caution', color: 'var(--color-risk-caution)', desc: '终端内执行' },
  { name: 'L2', label: 'Warning', color: 'var(--color-risk-warning)', desc: '弹审批卡' },
  { name: 'L3', label: 'Danger', color: 'var(--color-risk-danger)', desc: '必须确认' },
  { name: 'L4', label: 'Critical', color: 'var(--color-risk-critical)', desc: '二次密码' },
] as const;

export function ThemePreview({ themes, currentTheme, onThemeChange }: ThemePreviewProps) {
  const [pulseDemo, setPulseDemo] = useState(false);

  return (
    <main className="mx-auto max-w-7xl px-6 py-8 space-y-12">
      {/* === Header === */}
      <header className="space-y-3">
        <div className="flex items-center gap-3">
          <span
            className="font-mono text-3xl font-bold"
            style={{ color: 'var(--color-primary)' }}
          >
            {'[>_]'} TDSF
          </span>
          <span className="text-text-muted text-sm font-mono">v4.0</span>
        </div>
        <p className="text-text-muted text-sm">
          终端优先的 Linux 运维 AI 工作台 — P0 样式系统验收
        </p>
      </header>

      {/* === Section 1: 主题切换器 (15 内置) === */}
      <section className="space-y-4">
        <h2 className="text-xl font-display font-bold flex items-center gap-2">
          <span style={{ color: 'var(--color-primary)' }}>01.</span>
          主题系统 (15 内置)
        </h2>
        <div className="flex flex-wrap gap-2">
          {themes.map((theme) => (
            <button
              key={theme}
              onClick={() => onThemeChange(theme)}
              className={`
                px-3 py-1.5 rounded-md text-sm font-mono interactive
                ${currentTheme === theme
                  ? 'bg-primary text-text-on-primary'
                  : 'bg-surface text-text-muted hover:bg-surface-hover hover:text-foreground border border-border'
                }
              `}
            >
              {theme}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-faint font-mono">
          当前主题: <span style={{ color: 'var(--color-primary)' }}>{currentTheme}</span>
          {' · '}主题切换只改 CSS 变量, 零运行时开销
        </p>
      </section>

      {/* === Section 2: 7 状态 Mood Ring === */}
      <section className="space-y-4">
        <h2 className="text-xl font-display font-bold flex items-center gap-2">
          <span style={{ color: 'var(--color-primary)' }}>02.</span>
          7 状态 Mood Ring
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
          {MOOD_STATES.map((mood) => (
            <div
              key={mood.name}
              className="card flex flex-col items-center gap-2 text-center"
            >
              <div
                className={`mood-${mood.name} w-10 h-10 rounded-full flex items-center justify-center`}
                style={{
                  background: `var(--color-mood-${mood.name})`,
                  boxShadow: `0 0 14px var(--color-mood-${mood.name})`,
                }}
              >
                <MoodIcon state={mood.name} />
              </div>
              <div className="text-xs font-mono font-semibold">{mood.label}</div>
              <div className="text-[10px] text-text-faint">{mood.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* === Section 3: 5 档风险段条 === */}
      <section className="space-y-4">
        <h2 className="text-xl font-display font-bold flex items-center gap-2">
          <span style={{ color: 'var(--color-primary)' }}>03.</span>
          5 档风险等级 (L0-L4)
        </h2>
        <div className="card space-y-4">
          {RISK_LEVELS.map((risk) => (
            <div key={risk.name} className="space-y-2">
              <div className="flex items-center gap-3">
                <span
                  className="font-mono font-bold text-sm w-12 shrink-0"
                  style={{ color: risk.color }}
                >
                  {risk.name}
                </span>
                <div className="flex items-center gap-0.5 flex-1">
                  {RISK_LEVELS.map((seg, i) => (
                    <div
                      key={seg.name}
                      className="h-2 flex-1"
                      style={{
                        background: i <= RISK_LEVELS.findIndex((r) => r.name === risk.name)
                          ? seg.color
                          : 'rgba(255,255,255,0.06)',
                        borderRadius:
                          i === 0
                            ? '2px 0 0 2px'
                            : i === RISK_LEVELS.length - 1
                              ? '0 2px 2px 0'
                              : '0',
                      }}
                    />
                  ))}
                </div>
                <span className="text-xs font-mono text-text-muted shrink-0">
                  {risk.label} · {risk.desc}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* === Section 4: 字体 === */}
      <section className="space-y-4">
        <h2 className="text-xl font-display font-bold flex items-center gap-2">
          <span style={{ color: 'var(--color-primary)' }}>04.</span>
          字体体系
        </h2>
        <div className="card space-y-3">
          <div>
            <div className="text-xs text-text-faint mb-1 font-mono">Inter Variable · UI</div>
            <p className="text-base">
              The quick brown fox jumps over the lazy dog.
              <span className="text-text-muted ml-2">0123456789</span>
            </p>
          </div>
          <div>
            <div className="text-xs text-text-faint mb-1 font-mono">Maple Mono NF · 终端</div>
            <p className="font-mono text-sm leading-relaxed">
              $ sudo systemctl restart nginx
              <br />
              <span style={{ color: 'var(--color-success)' }}>●</span>{' '}
              <span style={{ color: 'var(--terminal-green)' }}>nginx.service</span> - A high performance web server
              <br />
              <span style={{ color: 'var(--color-text-faint)' }}>   Loaded: loaded</span>
            </p>
          </div>
          <div>
            <div className="text-xs text-text-faint mb-1 font-mono">JetBrains Mono · 代码</div>
            <pre className="font-code text-sm leading-relaxed">
              <code>
                <span style={{ color: 'var(--code-keyword)' }}>const</span>{' '}
                <span style={{ color: 'var(--code-variable)' }}>agent</span>{' '}
                <span style={{ color: 'var(--code-operator)' }}>=</span>{' '}
                <span style={{ color: 'var(--code-keyword)' }}>new</span>{' '}
                <span style={{ color: 'var(--code-function)' }}>TerminalAgent</span>
                <span style={{ color: 'var(--code-operator)' }}>(</span>
                <span style={{ color: 'var(--code-string)' }}>'claude-4.5'</span>
                <span style={{ color: 'var(--code-operator)' }}>)</span>
                <span style={{ color: 'var(--code-operator)' }}>;</span>
              </code>
            </pre>
          </div>
        </div>
      </section>

      {/* === Section 5: 按钮 === */}
      <section className="space-y-4">
        <h2 className="text-xl font-display font-bold flex items-center gap-2">
          <span style={{ color: 'var(--color-primary)' }}>05.</span>
          按钮组件
        </h2>
        <div className="card flex flex-wrap gap-3">
          <button className="btn-primary inline-flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5" />
            Primary
          </button>
          <button className="btn-outline">Outline</button>
          <button className="btn-ghost inline-flex items-center gap-1.5">
            <Circle className="w-3.5 h-3.5" />
            Ghost
          </button>
          <button className="btn-danger inline-flex items-center gap-1.5">
            <X className="w-3.5 h-3.5" />
            Danger
          </button>
          <button
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-mono interactive"
            style={{
              background: 'var(--color-warning)',
              color: 'var(--color-text-on-primary)',
            }}
            onClick={() => setPulseDemo(!pulseDemo)}
          >
            {pulseDemo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AlertTriangle className="w-3.5 h-3.5" />}
            {pulseDemo ? 'Loading…' : 'Warning'}
          </button>
        </div>
      </section>

      {/* === Section 6: 终端模拟 === */}
      <section className="space-y-4">
        <h2 className="text-xl font-display font-bold flex items-center gap-2">
          <span style={{ color: 'var(--color-primary)' }}>06.</span>
          终端模拟 (终端主区永真 PTY)
        </h2>
        <div
          className="rounded-lg p-4 font-mono text-sm leading-relaxed overflow-x-auto"
          style={{
            background: 'var(--terminal-bg)',
            color: 'var(--terminal-fg)',
            border: '1px solid var(--color-border)',
            minHeight: '160px',
          }}
        >
          <div>
            <span style={{ color: 'var(--color-success)' }}>[user@host-01 ~]$</span>{' '}
            <span>sudo nginx -t</span>
          </div>
          <div className="mt-1" style={{ color: 'var(--terminal-cyan)' }}>
            nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
          </div>
          <div style={{ color: 'var(--terminal-green)' }}>
            nginx: configuration file /etc/nginx/nginx.conf test is successful
          </div>
          <div className="mt-2">
            <span style={{ color: 'var(--color-success)' }}>[user@host-01 ~]$</span>{' '}
            <span>echo </span>
            <span style={{ color: 'var(--terminal-yellow)' }}>"hello tdsf"</span>
            <span className="terminal-cursor inline-block w-2 h-4 align-middle ml-1" />
          </div>
        </div>
      </section>

      {/* === Section 7: 间距 / 圆角 / 阴影 === */}
      <section className="space-y-4">
        <h2 className="text-xl font-display font-bold flex items-center gap-2">
          <span style={{ color: 'var(--color-primary)' }}>07.</span>
          Tokens 速查
        </h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card space-y-3">
            <h3 className="text-sm font-mono font-semibold" style={{ color: 'var(--color-primary)' }}>
              圆角 (4 档)
            </h3>
            <div className="flex flex-wrap gap-2">
              {(['sm', 'md', 'lg', 'xl'] as const).map((r) => (
                <div
                  key={r}
                  className="w-16 h-16 flex items-center justify-center text-xs font-mono"
                  style={{
                    background: 'var(--color-primary-soft)',
                    border: '1px solid var(--color-primary)',
                    borderRadius: `var(--radius-${r})`,
                  }}
                >
                  {r}
                </div>
              ))}
            </div>
          </div>
          <div className="card space-y-3">
            <h3 className="text-sm font-mono font-semibold" style={{ color: 'var(--color-primary)' }}>
              阴影 (3 档)
            </h3>
            <div className="flex flex-wrap gap-4">
              {(['low', 'medium', 'high'] as const).map((s) => (
                <div
                  key={s}
                  className="w-20 h-20 rounded-md flex items-center justify-center text-xs font-mono"
                  style={{
                    background: 'var(--color-surface)',
                    boxShadow: `var(--shadow-${s})`,
                  }}
                >
                  {s}
                </div>
              ))}
              <div
                className="w-20 h-20 rounded-lg flex items-center justify-center text-xs font-mono"
                style={{
                  background: 'var(--color-bg-elevated)',
                  border: '1px solid var(--color-border)',
                  boxShadow: 'var(--shadow-panel)',
                }}
              >
                panel
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* === Footer === */}
      <footer className="text-xs text-text-faint font-mono pt-8 border-t border-border">
        <div className="flex items-center justify-between">
          <span>TDSF Terminal Agent v4.0 · P0 样式系统验收</span>
          <span className="flex items-center gap-2">
            {currentTheme === 'dark' ? <Moon className="w-3 h-3" /> : <Sun className="w-3 h-3" />}
            {currentTheme}
          </span>
        </div>
      </footer>
    </main>
  );
}

function MoodIcon({ state }: { state: string }) {
  const color = 'var(--color-text-on-primary)';
  const dot = <span className="w-1 h-1 rounded-full inline-block" style={{ background: color }} />;
  switch (state) {
    case 'idle':
      return <Circle className="w-3 h-3" style={{ color }} />;
    case 'thinking':
      return (
        <span className="flex gap-0.5">
          {dot}
          {dot}
          {dot}
        </span>
      );
    case 'stream':
      return <span className="w-1 h-3" style={{ background: color, animation: 'caret-blink 1s step-end infinite' }} />;
    case 'working':
      return <Loader2 className="w-3 h-3 animate-spin" style={{ color }} />;
    case 'waiting':
      return <span className="w-2 h-2 rounded-full" style={{ background: color }} />;
    case 'done':
      return <Check className="w-3 h-3" style={{ color }} />;
    case 'error':
      return <X className="w-3 h-3" style={{ color }} />;
    default:
      return null;
  }
}
