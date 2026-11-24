import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The iPhone and iPad window. src-mobile/tauri.conf.json loads its build.
export default defineConfig({
  plugins: [react()],
  root: 'src/mobile',
  base: './',
  clearScreen: false,
  build: { outDir: '../../dist-mobile', emptyOutDir: true },
})
