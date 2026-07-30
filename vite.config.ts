import { defineConfig } from 'vite'
import { networkInterfaces } from 'node:os'
import react from '@vitejs/plugin-react'

const localGenerationOrigin = 'http://127.0.0.1:8787'

function generationApiOrigin() {
  const configuredOrigin = process.env.VITE_GENERATION_API_ORIGIN
  if (configuredOrigin) return configuredOrigin

  // Codex 局域网预览会把 Vite 暴露为 172.x 地址；此时 127.0.0.1 指向的是
  // 预览容器而非本机生图服务。优先使用本机的预览网卡访问同机 :8787。
  const previewAddress = Object.values(networkInterfaces())
    .flat()
    .find((network) => network?.family === 'IPv4' && !network.internal && network.address.startsWith('172.30.'))
    ?.address
  if (previewAddress) return `http://${previewAddress}:8787`
  return localGenerationOrigin
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': {
        target: generationApiOrigin(),
        changeOrigin: true,
      },
    },
  },
})
