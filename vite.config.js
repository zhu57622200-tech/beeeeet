import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// 注意：DeepSeek key 从 .env.local 读取，绝不出现在前端代码里。
// 通过 dev/preview server 的代理在请求转发时注入 Authorization 头。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const DEEPSEEK_KEY = env.DEEPSEEK_KEY || ''

  // dev 与 preview 共用同一套代理（避免 preview 模式下 DeepSeek/Polymarket 静默失效）。
  const proxy = {
    // 联机版后端（dev/preview 本地联调；生产由 nginx 反代）
    '/api': {
      target: env.VITE_API_TARGET || 'http://127.0.0.1:8788',
      changeOrigin: true,
    },
    // Polymarket Gamma API
    '/pm': {
      target: 'https://gamma-api.polymarket.com',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/pm/, ''),
    },
    // DeepSeek API —— 在 proxyReq 阶段注入 Authorization 头
    '/ds': {
      target: 'https://api.deepseek.com',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/ds/, ''),
      configure: (proxy) => {
        proxy.on('proxyReq', (proxyReq) => {
          if (DEEPSEEK_KEY) {
            proxyReq.setHeader('Authorization', `Bearer ${DEEPSEEK_KEY}`)
          }
        })
      },
    },
  }

  return {
    plugins: [vue()],
    server: { host: true, proxy }, // host:true 暴露局域网,手机同WiFi可访问测试
    preview: { host: true, proxy },
    test: {
      environment: 'node',
    },
  }
})
