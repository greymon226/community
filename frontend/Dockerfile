# ---- frontend build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: nginx 既托管静态资源也做后端反向代理 ----
FROM nginx:1.27-alpine

RUN apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone

# 默认 HTTP 配置，模板里用 envsubst 注入 BACKEND_HOST
COPY nginx.conf /etc/nginx/templates/default.conf.template

# 让 nginx 镜像自带的入口在启动时把模板渲染到 /etc/nginx/conf.d/
ENV BACKEND_HOST=backend
ENV BACKEND_PORT=4000

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
