#!/bin/bash
# 如影 AI 能力开放平台 v2.4.0 —— 新服务器 116.181.19.193 部署脚本
# 不用 docker compose（本机没有 compose 插件），直接用 docker run。
# 用法：bash /opt/paas_v3/deploy/run.sh
set -e
cd /opt/paas_v3/deploy

# 1. 网络与数据卷（已存在则跳过）
docker network create paas-net 2>/dev/null || true
docker volume create ruying-data 2>/dev/null || true

# 2. 构建镜像（dist 已预构建，不跑 npm）
docker build -f Dockerfile.server -t yunfan-digital-human:2.4.0 /opt/paas_v3

# 3. 停掉旧容器（如果有）
docker rm -f paas-experience paas-nginx 2>/dev/null || true

# 4. 启动体验站容器
docker run -d --name paas-experience \
  --network paas-net \
  --env-file /opt/paas_v3/.env \
  -v /opt/paas_v3/.env:/app/.env:ro \
  -v ruying-data:/app/data \
  -e PORT=8080 -e MOCK_TASK_MS=1400 \
  -p 8080:8080 \
  --restart unless-stopped \
  yunfan-digital-human:2.4.0

# 5. 启动 nginx 容器（80 -> /digital-human/）
docker run -d --name paas-nginx \
  --network paas-net \
  -v /opt/paas_v3/deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro \
  -p 80:80 \
  --restart unless-stopped \
  nginx:alpine

echo "=== status ==="
docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}"
