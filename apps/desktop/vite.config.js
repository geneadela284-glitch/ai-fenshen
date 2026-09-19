import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
      '@data': path.resolve(process.cwd(), '../../data')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
