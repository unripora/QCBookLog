#!/bin/bash
# 快速构建并推送前端镜像

VERSION=${1:-v0.9.85}
IMAGE="crpi-bpk9dy6331fn5ymt.cn-hangzhou.personal.cr.aliyuncs.com/unripora/qc-booklog-frontend"

echo "🔨 构建镜像 $IMAGE:$VERSION ..."
docker build -t $IMAGE:$VERSION .

echo "📤 推送镜像 ..."
docker push $IMAGE:$VERSION

echo ""
echo "✅ 完成！"
echo "📝 下一步：在服务器上执行以下命令："
echo "   1. 更新 docker-compose.yml 中的镜像版本为 $VERSION"
echo "   2. 执行: docker-compose pull && docker-compose up -d"
