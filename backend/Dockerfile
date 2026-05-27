# ---- backend production image ----
FROM node:20-alpine

# 时区与基础工具
RUN apk add --no-cache tzdata curl \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app

# 仅装运行时依赖（跳过 dev 与 optional 中的 sqlite3 原生编译）
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# 拷贝源码
COPY . .

# 创建上传目录（运行时由 volume 挂载覆盖）
RUN mkdir -p /app/uploads

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/health || exit 1

CMD ["node", "src/app.js"]
