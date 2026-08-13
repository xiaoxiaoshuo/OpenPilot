#!/bin/bash
# OpenPilot Chat 容器入口：在同一容器内并行启动 4 个服务。
# 各服务必须在其自身目录运行：
#   - IdP 会在 cwd 生成 .idp-jwk.json（签名密钥）
#   - core 使用绝对路径 CORE_DATA_DIR=/app/data，不受 cwd 影响
#   - gateway / web-ui 依赖 import.meta.url 定位，也不受 cwd 影响
#
# 注意：用 bash 而非 /bin/sh（Debian 的 sh 是 dash，不支持 wait -n）

set -e

# 收到 TERM/INT 时把信号转给所有子进程，保证优雅退出
trap 'kill -TERM $(jobs -p) 2>/dev/null || true' TERM INT

cd /app/core && node src/index.ts &
cd /app/IdP && node src/index.ts &
cd /app/web-ui && node server/index.ts &
cd /app/gateway && node src/server.ts &

# 任一服务退出（含崩溃）则整个容器退出
wait -n
