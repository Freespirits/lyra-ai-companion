import { defineConfig } from 'vite';
const API = 'http://localhost:' + (process.env.PORT || 8686);
export default defineConfig({
  server: {
    proxy: {
      '/api': API,
      '/ears': { target: API.replace('http', 'ws'), ws: true },
      '/stt': { target: API.replace('http', 'ws'), ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 3000 },
});
