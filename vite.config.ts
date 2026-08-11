import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Vite 6 + React 19 + Tailwind v4 配置
// 参考: https://tailwindcss.com/docs/installation/using-vite
// Vitest 配置在独立的 vitest.config.ts (用 mergeConfig 共享)
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
  worker: {
    format: 'es',
  },
  build: {
    target: 'esnext',     // Tauri WebView 2 支持 ES2022+
    minify: 'esbuild',
    sourcemap: false,
    outDir: 'dist',
    emptyOutDir: true,
  },
});
