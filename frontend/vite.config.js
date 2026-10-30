import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tailwind v4 is configured through its Vite plugin and src/index.css (no tailwind.config.js needed).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Same-origin API calls in dev, so the httpOnly session cookie just works.
      // VITE_API_PROXY_TARGET overrides the backend address (e.g. when port 4000 is taken).
      '/api': { target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:4000', changeOrigin: false },
    },
  },
});
