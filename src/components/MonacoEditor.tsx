/**
 * MonacoEditor.tsx — Monaco Editor 封装 (T-P2-06)
 * -----------------------------------------------------------------------------
 * 职责:
 *   1. 封装 @monaco-editor/react 的 Editor 组件
 *   2. 自动检测语言 (基于文件扩展名 → Monaco language id)
 *   3. 受控更新 content (onChange → dispatch update-file)
 *   4. Ctrl+S 触发 SFTP 上传 (调用 sftpWrite)
 *   5. 200+ 语言语法高亮 (Monaco Editor 原生支持)
 *
 * 与 store 的关系:
 *   - 父组件 (EditorTabs/Explorer) 传入 OpenFileItem 的 path + content
 *   - onChange 更新 store.openFiles[path].content
 *   - Ctrl+S 调用 sftpWrite 上传,上传成功后更新 originalContent (清除 dirty 标记)
 *
 * Monaco Editor 加载策略:
 *   - monaco-editor npm 包通过 main.tsx 的 loader.config({ monaco }) 注入
 *   - worker 通过 Vite ?worker 后缀打包 (见 main.tsx)
 *   - 不依赖 CDN (国内网络不可靠)
 *
 * 性能:
 *   - 大文件 (>1MB) 不加载到 Monaco (前端拦截,显示提示)
 *   - 同一 path 复用 editor 实例 (避免重复 createModel)
 *
 * 错误处理:
 *   - 加载/保存错误显示在 editor 顶部 banner
 *   - 错误不阻塞编辑 (用户可继续编辑)
 */
import { useCallback, useMemo } from 'react';
import Editor, { type OnMount, type Monaco } from '@monaco-editor/react';
import { useRuntime } from '../store/runtime';
import { sftpWrite, encodeUtf8 } from '../lib/sftp-bridge';

interface MonacoEditorProps {
  /** 远程文件路径 (作为 Monaco model 的唯一 key) */
  path: string;
  /** 文件内容 (受控) */
  content: string;
  /** Monaco language id (如 'javascript'),空字符串表示自动检测 */
  language?: string;
  /** 文件大小 (字节,用于判断是否加载) */
  size: number;
  /** SSH 会话 ID (用于调用 sftpWrite) */
  sessionId: number | null;
  /** 是否只读 (如 .log 文件) */
  readOnly?: boolean;
}

/** 文件扩展名 → Monaco language id 映射 (常用 30+) */
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  // Web 前端
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', vue: 'html', svelte: 'html',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  // 配置 / 数据
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', xml: 'xml', csv: 'csv',
  // 后端 / 脚本
  py: 'python', rb: 'ruby', php: 'php', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', scala: 'scala', clj: 'clojure',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', fs: 'fsharp', swift: 'swift', dart: 'dart',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', bat: 'bat', cmd: 'bat',
  // 数据库
  sql: 'sql', psql: 'sql',
  // 文档
  md: 'markdown', markdown: 'markdown', rst: 'rst',
  // 系统配置
  conf: 'ini', cfg: 'ini', properties: 'ini',
  dockerfile: 'dockerfile', makefile: 'makefile',
  // 其他
  lua: 'lua', r: 'r', rkt: 'scheme', scm: 'scheme',
  pl: 'perl', pm: 'perl', ex: 'elixir', exs: 'elixir',
  erl: 'erlang', hs: 'haskell', ml: 'ocaml',
};

/** 从文件路径推断 Monaco language id */
// eslint-disable-next-line react-refresh/only-export-components
export function detectLanguage(path: string): string {
  // 特殊文件名 (无扩展名)
  const basename = path.split('/').pop() ?? '';
  const lower = basename.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
  if (lower === 'makefile' || lower === 'gnumakefile') return 'makefile';
  if (lower === '.bashrc' || lower === '.zshrc' || lower === '.profile') return 'shell';
  if (lower === '.gitignore' || lower === '.npmignore') return 'ignore';
  if (lower === '.env' || lower.startsWith('.env.')) return 'ini';

  // 按扩展名查找
  const dotIdx = basename.lastIndexOf('.');
  if (dotIdx <= 0) return 'plaintext'; // 无扩展名或隐藏文件
  const ext = basename.slice(dotIdx + 1).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] ?? 'plaintext';
}

/** 大文件阈值 (1MB,超过则不加载到 Monaco) */
const MAX_FILE_SIZE = 1 * 1024 * 1024;

export function MonacoEditor({
  path,
  content,
  language = '',
  size,
  sessionId,
  readOnly = false,
}: MonacoEditorProps) {
  const { dispatch } = useRuntime();

  // 自动检测语言 (若未指定)
  const monacoLanguage = useMemo(() => {
    if (language) return language;
    return detectLanguage(path);
  }, [language, path]);

  // === Ctrl+S 保存 ===
  const handleSave = useCallback(async () => {
    if (sessionId === null) {
      dispatch({
        type: 'update-file',
        path,
        updates: { error: 'SSH 会话未连接,无法保存' },
      });
      return;
    }
    if (readOnly) return;

    dispatch({
      type: 'update-file',
      path,
      updates: { error: null },
    });

    try {
      const bytes = encodeUtf8(content);
      await sftpWrite(sessionId, path, bytes);
      // 保存成功: 更新 originalContent (清除 dirty 标记)
      dispatch({
        type: 'update-file',
        path,
        updates: { originalContent: content, error: null },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({
        type: 'update-file',
        path,
        updates: { error: `保存失败: ${msg}` },
      });
    }
  }, [sessionId, path, content, readOnly, dispatch]);

  // === Monaco Editor 挂载 ===
  const handleMount: OnMount = useCallback(
    (editor, monacoInstance: Monaco) => {
      // 注册 Ctrl+S / Cmd+S 快捷键
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
        void handleSave();
      });

      // 注册 Ctrl+B 阻止 (避免与 TDSF sidebar 切换冲突)
      // 注: 不阻止,让全局快捷键处理

      // 焦点设置
      editor.focus();
    },
    [handleSave],
  );

  // === 内容变更 (受控更新) ===
  const handleChange = useCallback(
    (value: string | undefined) => {
      const newContent = value ?? '';
      dispatch({
        type: 'update-file',
        path,
        updates: { content: newContent },
      });
    },
    [path, dispatch],
  );

  // === 大文件拦截 ===
  if (size > MAX_FILE_SIZE) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <div style={{ fontSize: '13px', marginBottom: '8px' }}>
          文件过大,未加载到编辑器
        </div>
        <div
          style={{
            fontSize: '11px',
            color: 'var(--color-text-faint)',
            fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
          }}
        >
          {path} ({(size / 1024 / 1024).toFixed(2)} MB &gt; 1 MB 上限)
        </div>
        <div
          style={{
            fontSize: '10px',
            color: 'var(--color-text-faint)',
            marginTop: '16px',
            maxWidth: '320px',
            textAlign: 'center',
          }}
        >
          建议在终端使用 vim/nano 编辑,或下载到本地处理
        </div>
      </div>
    );
  }

  // === sessionId 缺失时仅显示只读 ===
  const effectiveReadOnly = readOnly || sessionId === null;

  return (
    <div className="flex flex-col h-full w-full" data-testid="tdsf-monaco-editor">
      <Editor
        path={path}
        language={monacoLanguage}
        value={content}
        onChange={handleChange}
        onMount={handleMount}
        theme="vs-dark"
        options={{
          readOnly: effectiveReadOnly,
          automaticLayout: true,
          fontSize: 13,
          fontFamily:
            "'JetBrains Mono', 'Maple Mono NF', 'Cascadia Code', Consolas, monospace",
          fontLigatures: true,
          lineHeight: 1.6,
          minimap: { enabled: true, renderCharacters: false },
          scrollBeyondLastLine: false,
          wordWrap: 'off',
          tabSize: 2,
          insertSpaces: true,
          renderWhitespace: 'selection',
          renderControlCharacters: false,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          smoothScrolling: true,
          bracketPairColorization: { enabled: true },
          guides: {
            bracketPairs: true,
            indentation: true,
          },
          // 200+ 语言语法高亮由 Monaco Editor 内置
          // 通过 language prop 切换,无需额外配置
        }}
        loading={
          <div
            className="flex items-center justify-center h-full"
            style={{
              color: 'var(--color-text-muted)',
              fontSize: '12px',
              fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
            }}
          >
            加载 Monaco Editor...
          </div>
        }
      />
    </div>
  );
}
