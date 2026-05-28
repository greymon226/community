# 企业级技术交流分享社区

![Node 18+](https://img.shields.io/badge/Node-18%2B-339933?logo=nodedotjs&logoColor=white)
![React 18](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![Tests 37 Properties](https://img.shields.io/badge/PBT-37%20Properties-brightgreen)
![License MIT](https://img.shields.io/badge/License-MIT-blue)
![AI Native](https://img.shields.io/badge/AI%20Native-Kiro%20Spec%20Driven-blueviolet)

基于需求文档实现的企业级技术交流社区，支持用户认证、内容管理、互动、搜索、运营管理、消息通知、AI 辅助等功能。

## 技术栈

- **后端**：Node.js + Express + Sequelize（默认 MySQL，可切换 SQLite）+ JWT + Redis（可选缓存）
- **前端**：React 18 + Vite + Ant Design + Zustand + React Router
- **认证**：CAS 单点登录（提供 Mock 实现，便于本地开发；生产环境对接真实 CAS）
- **搜索**：内置全文搜索（基于数据库 LIKE + 倒排），可平滑替换为 Elasticsearch
- **AI**：DeepSeek（OpenAI 兼容协议），用于内容审核 / 帖子解读 / 站内 RAG 问答；未配置 Key 时自动降级到本地规则

## 目录结构

```
community/
├── backend/                # 后端服务
│   ├── src/
│   │   ├── config/         # 配置
│   │   ├── models/         # 数据模型
│   │   ├── controllers/    # 控制器
│   │   ├── services/       # 业务服务（含 AI、CAS 抽象）
│   │   ├── middlewares/    # 鉴权、日志、错误处理
│   │   ├── routes/         # 路由
│   │   ├── utils/          # 工具
│   │   └── app.js
│   ├── tests/              # 端到端测试
│   ├── seed.js             # 初始化数据
│   ├── package.json
│   └── .env.example
├── frontend/               # 前端 SPA
│   ├── src/
│   │   ├── api/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── store/
│   │   ├── router/
│   │   └── main.jsx
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
├── docker-compose.yml      # MySQL + Redis 一键启动
└── README.md
```

## 快速开始

> 推荐：先用 Docker 启动 MySQL + Redis，再分别启动后端与前端。

```bash
# 1. 启动数据库与缓存（在仓库根目录）
docker compose up -d
```

### 1.1 后端

```bash
cd backend
npm install
copy .env.example .env
npm run seed        # 初始化板块、管理员、示例数据
npm run dev         # 启动开发服务（默认 http://localhost:4000）
```

> 不想用 Docker？把 `.env` 中的 `DB_DIALECT` 改为 `sqlite`，再执行 `npm i sqlite3`（需要本地具备 C/C++ 编译能力）。

默认账号：

| 角色 | 工号/账号 | 密码 |
| --- | --- | --- |
| 超级管理员 | admin | admin123 |
| 版主 | mod001 | mod123 |
| 普通用户 | user001 | user123 |

> 真实环境下使用 CAS 单点登录，无需密码；此处密码登录仅用于本地 Mock CAS。

### 1.2 前端

```bash
cd frontend
npm install
npm run dev         # 默认 http://localhost:5173
```

## 切换到生产配置

- **MySQL**：`backend/.env` 中 `DB_DIALECT=mysql` 并填写连接串。
- **Redis**：填写 `REDIS_URL`，未配置时自动降级为内存缓存。
- **CAS**：实现 `backend/src/services/casService.js` 中的 `verifyTicket`，对接企业 CAS。
- **Elasticsearch**：实现 `backend/src/services/searchService.js` 的 ES 客户端版本即可。
- **AI（DeepSeek）**：在 `backend/.env` 中填写

  ```env
  AI_PROVIDER=deepseek
  AI_API_KEY=sk-xxxxxxxx
  AI_BASE_URL=https://api.deepseek.com
  AI_MODEL=deepseek-chat
  ```

  配置后重启后端，发帖 / 评论会走 AI 审核，帖子详情可用 AI 解读，首页"AI 问答"使用站内 RAG。在 `管理后台 → 系统设置` 可一键测试连通性，调用失败会自动降级为本地规则，业务不中断。

## MCP Server（双向 AI 原生）

本项目额外提供 MCP Server，让外部 AI 助手（Kiro、Claude Desktop、任意 MCP Client）能反向调用社区能力，实现"项目用 AI"+"AI 用项目"双向闭环。

**4 个工具**：`search_posts`（全文搜索）、`get_post`（取帖子）、`ask_community`（站内 RAG 问答）、`recommend_posts`（标签推荐）。

### 部署形态

生产环境 (`docker-compose.prod.yml`) 中 MCP 以独立容器 `mcp` 运行 HTTP 模式，由 frontend nginx 反代到 `/mcp` 路径，对外只暴露 80/443，3001 端口不绑定主机：

```
公网 ──> nginx :80 ──> /api/* ──> backend:4000
                  └─> /mcp    ──> mcp:3001 (独立容器)
```

### 在线 MCP 端点

线上演示环境已开放：

```bash
# 列出工具
curl http://124.222.8.86/mcp/tools

# 调用 search_posts
curl -X POST http://124.222.8.86/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"search_posts","arguments":{"keyword":"React"}}}'
```

### 客户端接入（Kiro / Claude Desktop）

```json
{
  "mcpServers": {
    "community-platform": {
      "url": "http://124.222.8.86/mcp",
      "autoApprove": ["search_posts", "get_post", "recommend_posts"]
    }
  }
}
```

零安装：配置完即可在 IDE 对话框直接提问"搜索社区里关于 React 的帖子"，AI 会自动调用 MCP 工具。

### 本地启动 MCP（开发）

```bash
cd backend

# stdio 模式（本地 IDE）
node src/mcp/index.js

# HTTP 模式（容器/远端）
node src/mcp/index.js --http   # 默认监听 0.0.0.0:3001
```

详细文档见 `backend/src/mcp/README.md`。

## 数据库结构同步

默认启动只跑 `sequelize.sync()`，不会更改已存在的表结构。模型变更后想增量同步一次，启动时设置 `DB_SYNC_ALTER=1`：

```bash
DB_SYNC_ALTER=1 npm run start
```

> 不要在长期运行的环境保持 `alter` 开启，Sequelize 会反复追加唯一索引，最终触发 MySQL `Too many keys` 报错。

## 已实现的需求映射

| 需求 | 实现位置 |
| --- | --- |
| CAS 单点登录 | `backend/src/services/casService.js`、`routes/auth.js` |
| 用户体系与个人中心 | `models/User.js`、`controllers/userController.js` |
| 多级板块 | `models/Category.js`、`controllers/categoryController.js` |
| 帖子（富文本/状态/编辑） | `models/Post.js`、`controllers/postController.js` |
| 评论 / 引用回复 | `models/Comment.js`、`controllers/commentController.js` |
| 点赞 / 收藏 | `models/Like.js`、`models/Favorite.js` |
| 全文搜索与排序 | `services/searchService.js` |
| 敏感词 / 举报 / 屏蔽 | `services/moderationService.js`、`models/Report.js` |
| 置顶 / 加精 | `controllers/postController.js`（admin 接口） |
| 角色权限分级 | `middlewares/auth.js` |
| 消息通知 | `models/Notification.js`、`services/notificationService.js` |
| AI 内容审核 / 推荐 / 解读 / 问答 | `services/aiService.js`、`controllers/aiController.js` |
| 操作审计日志 | `models/AuditLog.js` |
| XSS / SQL 注入防护 | `helmet`、`sanitize-html`、Sequelize 参数化 |

## 端到端测试

`backend/tests/` 下提供一组黑盒 e2e 用例，用纯 Node 编写、无第三方测试框架，方便在 CI 里直接跑。

```bash
# 1) 先在一个终端启动后端
cd backend
npm run start

# 2) 另一个终端跑全部用例
cd backend
npm run test:e2e
```

| 用例 | 覆盖点 |
| --- | --- |
| `auth_basic.e2e.js` | 登录 / 分类 / 发帖 / 点赞收藏 / 评论 / 加精 / 搜索 / admin stats / 通知 |
| `settings_toggle.e2e.js` | AI 审核开关：开启 vs 关闭时 `aiAuditStatus` 表现 |
| `ai_audit.e2e.js` | DeepSeek 协议层：mock 模型返回 + 失败降级（不依赖外网） |
| `post_block.e2e.js` | AI blocked → HTTP 400 + code=4002；草稿不走 AI |
| `ai_explain.e2e.js` | 帖子解读：首次调用 → 缓存命中 → 开关关闭 4003 |
| `ai_ask.e2e.js` | 站内 RAG 问答：检索 + 引用映射 + 缓存 + 开关 |

依赖：

- `auth_basic` / `settings_toggle` / `post_block` / `ai_explain` / `ai_ask` 需要后端在运行、`docker compose up -d` 起的 MySQL/Redis、`seed` 已执行
- 涉及真实 LLM 的用例需要 `.env` 中配置 DeepSeek `AI_API_KEY`；未配置时会自动跳过严格断言
- `ai_audit` 不需要后端进程，自带本地 mock，可独立运行

## 开发说明

后端入口：`backend/src/app.js`；前端入口：`frontend/src/main.jsx`。代码内含中文注释，方便二次开发。
