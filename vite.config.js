import { defineConfig } from 'vite';

export default defineConfig({
  base: '/projects/',
  build: {
    outDir: '/var/www/miro/projects',
    emptyOutDir: false,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
