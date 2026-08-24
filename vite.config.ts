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
  build: {
    rollupOptions: {
      output: {
        // 稳定的基础依赖单独缓存；画布依赖升级或业务代码更新时，不必让浏览器重下全部首屏脚本。
        manualChunks(id) {
          // CanvasEditorViews 包含节点渲染器与生成器交互，单独拆出后避免工作台入口超过
          // Vite 的 500 kB 提示阈值，同时保留 CanvasWorkspace 的按需加载边界。
          if (id.includes('src/features/canvas/CanvasEditorViews')) return 'canvas-editor'
          if (!id.includes('node_modules')) return undefined
          if (id.includes('@xyflow/react')) return 'canvas-flow'
          if (id.includes('@supabase/')) return 'supabase-client'
          if (id.includes('react-dom') || id.includes('/react/')) return 'react-vendor'
          if (id.includes('dexie') || id.includes('zustand')) return 'workspace-data'
          return undefined
        },
      },
    },
  },
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
