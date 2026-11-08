// 只读演示令牌的占位文件。
//
// 构建时打进产物（vite 的 public/ 会原样拷到 dist 根，/config.js 可被访问）。
// 部署时若设置了 VIGIL_DEMO_MEMBER_TOKEN，nginx 启动脚本 50-vigil-demo-config.sh
// 会用真实令牌覆盖本文件；没设置就保持空串 —— 前端按「无演示模式」处理。
//
// 存在这个占位文件是为了避免 /config.js 404（index.html 在 bundle 之前引用它）。
window.VIGIL_DEMO_MEMBER_TOKEN = "";
