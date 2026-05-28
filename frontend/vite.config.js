import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-router-dom/') || id.includes('/zustand/')) {
            return 'react-vendor';
          }
          if (id.includes('/@ant-design/icons')) return 'antd-icons';
          if (id.includes('/axios/') || id.includes('/dayjs/')) return 'http-vendor';
          if (id.includes('/highlight.js/')) return 'highlight';
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/uploads': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});
