import { libConfig } from './vite.lib'

/**
 * 会话回放入口产物：
 *   dist/replay.js      ESM
 *   dist/replay.iife.js 浏览器全局
 *
 * **单独构建**是必须的：rrweb 压缩后 260KB（gzip 约 80KB）。
 * 打进主入口会让核心从 13KB 膨胀到 90KB+，
 * 而绝大多数用户根本不需要回放（尤其涉及隐私合规的团队）。
 *
 * 这个构建**不清空** dist —— 否则会把上一个构建的产物删掉。
 */
export default libConfig({ replay: 'src/replay-entry.ts' }, 'replay', {
  emptyOutDir: false,
  formats: ['es', 'iife'],
  globalName: 'VigilReplay'
})
