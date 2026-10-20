# 前端Dockerfile - 多阶段构建（极速优化版本）
# 阶段1: 构建阶段
FROM docker.m.daocloud.io/library/node:18-alpine AS builder

WORKDIR /app

# 配置环境变量以加速构建
ENV npm_config_registry=https://registry.npmmirror.com \
    npm_config_fetch_retries=2 \
    npm_config_fetch_timeout=60000 \
    npm_config_strict_ssl=false \
    NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node

# 复制package文件（先复制package.json以利用缓存）
COPY package*.json ./

# 安装所有依赖（跳过后端编译脚本）
RUN npm install --prefer-offline --no-audit --no-fund --legacy-peer-deps --ignore-scripts

# 复制源代码（排除 server 目录）
COPY src/ ./src/
COPY public/ ./public/
COPY index.html ./
COPY vite.config.ts ./
COPY tsconfig.json ./

# 下载 Tesseract 语言包到 public/tessdata（构建产物会随静态资源一起打包）
# 语言包为 gzip 压缩格式（.traineddata.gz），与服务层 langPath='/tessdata' 对应
ARG TESSDATA_BASE=https://cdn.jsdelivr.net/npm/@tesseract.js-data
RUN set -eux; \
    mkdir -p public/tessdata; \
    for lang in chi_sim chi_tra eng jpn kor fra deu rus; do \
      for repo in "${lang}" "${lang}_traineddata"; do \
        url="${TESSDATA_BASE}/${repo}/4.0.0_best_int/${lang}.traineddata.gz"; \
        if wget -q -T 60 -O "public/tessdata/${lang}.traineddata.gz" "$url"; then break; fi; \
      done; \
      test -s "public/tessdata/${lang}.traineddata.gz"; \
    done; \
    ls -lh public/tessdata

# 拷贝 Tesseract 引擎核心与 Worker 脚本到静态资源目录
# core 随依赖安装已存在于 node_modules，单独指定 corePath 从同源加载，避免外网 CDN
# worker.min.js 为浏览器版 Worker 脚本，避免误用 Node 版（worker_threads 无法在浏览器克隆）
RUN mkdir -p public/tesseract-core public/tesseract-dist; \
    cp node_modules/tesseract.js-core/*.wasm.js node_modules/tesseract.js-core/*.wasm public/tesseract-core/; \
    cp node_modules/tesseract.js/dist/worker.min.js public/tesseract-dist/; \
    ls -lh public/tesseract-core public/tesseract-dist

# 构建生产版本（使用基本构建选项）
RUN npx vite build --mode production

# 阶段2: 生产阶段
FROM docker.m.daocloud.io/library/nginx:alpine

# 复制自定义Nginx配置
COPY nginx.conf /etc/nginx/nginx.conf

# 从构建阶段复制构建产物
COPY --from=builder /app/dist /usr/share/nginx/html

# 创建日志目录
RUN mkdir -p /var/log/nginx

# 暴露端口
EXPOSE 80

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/ || exit 1

# 启动Nginx
CMD ["nginx", "-g", "daemon off;"]