import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    proxy: { '/console': 'http://127.0.0.1:8080', '/download': 'http://127.0.0.1:8080' }
  }
})
