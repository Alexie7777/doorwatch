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

# 健康检查要同时认 HTTPS 和纯 HTTP:
#   - 部署成纯 HTTP(HTTPS=false)时,写死 https:// 会让容器一直被判成 unhealthy
#   - 部署成 HTTPS 时,自签证书会被 fetch 拒掉,同样 unhealthy
# 所以两种协议都试,HTTPS 那一路显式放行自签证书(rejectUnauthorized:false)。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const h=require('http'),s=require('https');const g=(u,o)=>new Promise(r=>{const c=(u.startsWith('https')?s:h).get(u,o,x=>{x.resume();r(x.statusCode===200)});c.on('error',()=>r(false));c.setTimeout(4000,()=>{c.destroy();r(false)})});(async()=>{for(const p of [['https://127.0.0.1:8443/api/health',{rejectUnauthorized:false}],['http://127.0.0.1:8443/api/health',{}]]){if(await g(p[0],p[1])){process.exit(0)}}process.exit(1)})()"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
