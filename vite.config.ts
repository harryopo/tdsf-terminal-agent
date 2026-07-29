import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// vite-plugin-monaco-editor 1.1.0 是 CJS 模块,Vite 6 ESM 配置下需用 createRequire 加载
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const monacoEditorPlugin = require('vite-plugin-monaco-editor').default as typeof import('vite-plugin-monaco-editor').default;
import path from 'node:path';

// Vite 6 + React 19 + Tailwind v4 配置
// 参考: https://tailwindcss.com/docs/installation/using-vite
// Vitest 配置在独立的 vitest.config.ts (用 mergeConfig 共享)
//
// Monaco Editor (T-P2-06):
//   - 使用 vite-plugin-monaco-editor 自动处理 worker 加载
//   - 插件会自动注入 MonacoEnvironment.getWorker 实现
//   - 避免 Vite 6 + pnpm 嵌套路径下 ?worker/?url 后缀无法解析的问题
//   - @monaco-editor/react 4.7 通过 loader.config({ monaco }) 注入本地 monaco 实例
//   - 避免 CDN 加载 (国内网络不可靠)
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Monaco Editor 插件: 自动配置 worker 加载
    // languageWorkers: 指定需要加载的专用 worker (json/css/html/ts)
    monacoEditorPlugin({
      languageWorkers: ['json', 'css', 'html', 'typescript'],
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@styles': path.resolve(__dirname, './src/styles'),
      '@components': path.resolve(__dirname, './src/components'),
    },
  },
  server: {
    port: 9300,           // 与 tauri.conf.json devUrl 对齐 (避开 Windows 保留段)
    strictPort: true,     // 端口被占用时直接报错,避免与 Tauri devUrl 不匹配
    host: '127.0.0.1',    // 强制 IPv4, 避免 Windows IPv6 绑定失败
  },
  // 修复: Vite v6 在 Windows 上 EACCES 的根因 — 显式禁用 host 检查
  preview: {
    host: '127.0.0.1',
    port: 9300,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  // Monaco Editor 0.56 ESM worker 配置
  // 参考: https://vitejs.dev/config/worker-options.html#worker-format
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',     // Tauri WebView 2 支持 ES2022+
    minify: 'esbuild',
    sourcemap: true,
    outDir: 'dist',
    emptyOutDir: true,
    // Monaco Editor worker 单独分包 (避免主 bundle 过大)
    rollupOptions: {
      output: {
        manualChunks: {
          'monaco-editor': ['monaco-editor'],
        },
      },
    },
  },
});
