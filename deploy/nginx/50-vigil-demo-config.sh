#!/bin/sh
# 把只读演示令牌写进前端运行时配置（config.js）。
#
# 由 nginx 官方镜像的 entrypoint 在启动时执行（/docker-entrypoint.d/ 下的脚本
# 按文件名顺序跑，排在 40-vigil-auth 之后）。
#
# 面板是**静态产物**，构建时不知道部署时的演示令牌，所以令牌在容器启动时
# 从环境变量 VIGIL_DEMO_MEMBER_TOKEN 落盘到 /config.js，前端在 index.html
# 里用 <script src="/config.js"> 在 bundle 之前读进来。
#
# 没设令牌：写空字符串，前端按「无演示模式」处理，不会报错。
set -e

CONFIG_JS=/usr/share/nginx/html/config.js
TOKEN="${VIGIL_DEMO_MEMBER_TOKEN:-}"

if [ -n "$TOKEN" ]; then
  # 令牌是 vmk_ 前缀的十六进制串，直接用双引号包成 JS 字符串字面量即可
  printf 'window.VIGIL_DEMO_MEMBER_TOKEN = "%s";\n' "$TOKEN" > "$CONFIG_JS"
  echo "[vigil] 已写入只读演示令牌到 /config.js"
else
  printf 'window.VIGIL_DEMO_MEMBER_TOKEN = "";\n' > "$CONFIG_JS"
  echo "[vigil] 未设置 VIGIL_DEMO_MEMBER_TOKEN，演示模式关闭"
fi
