# =====================================================================
#  IT 办公室门磁看板 —— 运行镜像
#
#  单容器包含:看板服务 + 内置 MQTT broker + SQLite
#  部署到任意一台有 Docker 的 Linux 机器上就能用
# =====================================================================
FROM node:24-alpine

# openssl 用来首次启动时生成自签证书(手机端 PWA 需要安全上下文)
RUN apk add --no-cache openssl tini

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY config ./config

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8443 \
    MQTT_PORT=1883 \
    TZ=Asia/Shanghai

VOLUME ["/data"]
EXPOSE 8443 1883

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('https://127.0.0.1:8443/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
