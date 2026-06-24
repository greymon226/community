# 一键部署指南

这套脚本把 Community Platform 用 Docker Compose 跑起来，包含：

- `frontend` 容器：Nginx 托管前端静态文件 + 反向代理 `/api`、`/uploads`、`/mcp`
- `backend` 容器：Node.js 运行时
- `mcp` 容器：MCP HTTP Server（外部 AI 调用社区能力的入口）
- `mysql` 容器：MySQL 8（仅在 docker 内网可访问）
- `redis` 容器：Redis 7（带密码，仅在 docker 内网可访问）

数据通过 docker volume 持久化（`mysql-data` / `redis-data` / `uploads-data`）。

## 适用环境

- Ubuntu 20.04 / 22.04 / 24.04
- Debian 11 / 12
- CentOS 7 / Rocky / AlmaLinux

需要：root 或 sudo、能联网、2 核 4G 起步、域名可选。

## 使用步骤

```bash
# 1. 把整个项目放到服务器上
git clone <你的仓库地址> community
cd community

# 2. 一键部署（首次）
bash deploy/deploy.sh
# 选 1) 首次部署
```

脚本会：

1. 检查 / 安装 Docker 与 Docker Compose
2. 询问域名、HTTP 端口、DeepSeek API Key
3. 生成 `.env.prod`，里面 MySQL 密码 / Redis 密码 / JWT_SECRET 全部用 `openssl rand` 生成强随机串
4. 构建 frontend / backend 镜像并启动 4 个容器
5. 灌入种子数据（默认账号 `admin / admin123`，登录后请立即改密码）

完成后访问 `http://你的域名/` 即可。

## 常用命令

```bash
bash deploy/deploy.sh up        # 构建 + 启动
bash deploy/deploy.sh update    # git pull + 重建（更新代码后用）
bash deploy/deploy.sh status    # 查看容器状态与健康检查
bash deploy/deploy.sh doctor    # 部署自检（Git / Docker / env / 健康端点）
bash deploy/deploy.sh logs      # tail 所有容器日志
bash deploy/deploy.sh seed      # 重新灌入种子（幂等，跳过已存在数据）
bash deploy/deploy.sh backup    # 备份 MySQL + uploads 到 ./backups/
bash deploy/deploy.sh down      # 停服（保留数据）
bash deploy/deploy.sh nuke      # 停服并删除所有数据卷（危险）
```

## 接入 HTTPS（强烈推荐）

脚本默认只起 HTTP。生产暴露公网必须套 HTTPS，建议在**宿主机**上装一层 Nginx + Certbot：

```bash
# Ubuntu/Debian
sudo apt install -y nginx certbot python3-certbot-nginx

# 把容器端口从 80 改成 8080，避免和宿主 Nginx 冲突
sed -i 's/^HTTP_PORT=80$/HTTP_PORT=8080/' .env.prod
bash deploy/deploy.sh up

# 配置宿主 Nginx
sudo tee /etc/nginx/sites-available/community <<'NGINX'
server {
    listen 80;
    server_name community.example.com;

    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE 流式问答必须关掉缓冲
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 120s;
    }
}
NGINX

sudo ln -s /etc/nginx/sites-available/community /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 自动签发 + 续期 HTTPS
sudo certbot --nginx -d community.example.com
```

## 安全清单

- [ ] `.env.prod` 权限 600，**不要**提交到 git（已加入根 `.gitignore`）
- [ ] 防火墙只放 22 / 80 / 443，关闭 3306 / 6379 / 4000 / 8080
- [ ] 登录默认账号后立即修改 `admin / mod001 / user001` 的密码
- [ ] 后台 → 系统设置：根据 DeepSeek 实际计费配额调整每日 AI 调用上限
- [ ] 接入 HTTPS（见上）
- [ ] 配置定时备份：`crontab -e` 加一行
  ```
  0 3 * * * cd /opt/community && bash deploy/deploy.sh backup >> /var/log/community-backup.log 2>&1
  ```
- [ ] 把 `backups/` 同步到对象存储（OSS/COS/S3）

## MCP Server（外部 AI 调用入口）

部署后会自动启动独立的 `community-mcp` 容器，提供 HTTP 模式的 MCP Server。
通过 frontend 容器的 nginx 反代到 80 端口的 `/mcp` 路径，**不暴露独立端口**，
对外只需要开放 80（或 HTTPS 443）即可。

### 外部 AI 助手配置

在 Kiro / Claude Desktop / Cursor 的 `mcp.json` 里加：

```json
{
  "mcpServers": {
    "community-platform": {
      "url": "http://你的域名/mcp",
      "disabled": false,
      "autoApprove": ["search_posts", "get_post", "recommend_posts"]
    }
  }
}
```

### 提供的 4 个工具

| 工具 | 用途 | 典型用法 |
| --- | --- | --- |
| `search_posts` | 全文搜索帖子 | "搜索社区里关于 React hooks 的帖子" |
| `get_post` | 获取帖子完整内容 | "把帖子 42 的内容拿给我看看" |
| `ask_community` | 站内 RAG 问答 | "公司内部 Node.js 怎么做连接池优化？" |
| `recommend_posts` | 标签推荐帖子 | "给我推荐 React 和 TypeScript 相关的帖子" |

### 调试

```bash
# 查看 MCP 容器日志
docker compose -f docker-compose.prod.yml logs -f mcp

# 测试 tools 列表
curl http://你的域名/mcp/tools

# 测试调用 search_posts
curl -X POST http://你的域名/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_posts","arguments":{"keyword":"React"}}}'
```

## 常见问题

**Q: 端口 80 被占用怎么办？**
改 `.env.prod` 里的 `HTTP_PORT=8080`，再 `bash deploy/deploy.sh up`。

**Q: 想换数据库密码怎么办？**
MySQL 容器初始化只看第一次启动时的环境变量，已存在的数据库密码必须进容器手工改：
```bash
docker compose -f docker-compose.prod.yml exec mysql \
  mysql -uroot -p<旧密码> -e "ALTER USER 'community'@'%' IDENTIFIED BY '新密码'; FLUSH PRIVILEGES;"
```
然后同步更新 `.env.prod` 里的 `DB_PASS` 并重启 backend。

**Q: 怎么从备份恢复？**
```bash
gunzip -c backups/db-YYYYMMDD-HHMMSS.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T mysql \
  mysql -uroot -p<密码> community
```

**Q: AI 调用一直 5001？**
- 检查 `.env.prod` 里 `AI_API_KEY` 是否有效
- 检查服务器能不能 `curl https://api.deepseek.com`
- 后台 → AI 测试，看返回结构里的 `apiKeyConfigured` 与 `elapsedMs`
