import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
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
 *
 * ## Element Plus 按需引入
 *
 * 面板只用了 24 个 Element Plus 组件，但 `app.use(ElementPlus)` 会把
 * **整个库**（1.1MB minified）+ 全部样式（400KB）打进产物。
 *
 * 改成按需引入后：
 *   - 未用到的组件、图标、样式一律不进包
 *   - `ElMessage` / `ElMessageBox` 也由 resolver 处理
 *     （**连带它们的样式**—— 手写 `import { ElMessage }` 只会带代码不带样式）
 */
export default defineConfig({
  plugins: [
    vue(),
    AutoImport({
      imports: ['vue'],
      resolvers: [ElementPlusResolver()],
      // 生成的声明文件**要提交** —— vue-tsc 靠它才知道
      // `ElMessage` 这些自动导入的名字存在（否则 typecheck 报「找不到名称」）
      dts: 'src/auto-imports.d.ts'
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: 'src/components.d.ts'
    })
  ],
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
