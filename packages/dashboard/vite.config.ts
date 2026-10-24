import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * 管理面板 dev server。
 *
 * ## /api 代理必须在服务端注入管理 token
 *
 * 面板的浏览器代码**不持有**管理 token —— 代理层把它加到请求头上。
 * 这样 token 不会出现在前端 bundle 里，也不会出现在浏览器网络面板里。
 *
 * 生产部署时同理：把静态资源和 /api 放在同一个源后面，
 * 由 nginx / 网关注入 token。
 */
export default defineConfig({
  plugins: [vue()],
  server: {
    // 钉死端口。Vite 默认在端口被占用时**静默递增**（5173 → 5174），
    // 面板的地址就会每次不一样。strictPort 让它直接报错而不是悄悄漂走。
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4318',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader(
              'x-vigil-admin-token',
              process.env.VIGIL_ADMIN_TOKEN ?? 'vigil_admin_demo'
            )
          })
        }
      }
    }
  }
})
