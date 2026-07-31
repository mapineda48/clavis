import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// El monorepo tiene un unico `.env` en la raiz (dos niveles por encima de packages/app).
// Vite debe leer de ahi las variables `VITE_*` en lugar de buscarlas en el paquete.
const monorepoRoot = fileURLToPath(new URL('../../', import.meta.url))

export default defineConfig({
  plugins: [react()],
  envDir: monorepoRoot,
  server: {
    port: 5173,
    strictPort: true,
    host: true,
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
