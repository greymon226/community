# 企业级技术交流分享社区

[![tests](https://github.com/greymon226/community/actions/workflows/test.yml/badge.svg)](https://github.com/greymon226/community/actions/workflows/test.yml)
![Node 20+](https://img.shields.io/badge/Node-20%2B-339933?logo=nodedotjs&logoColor=white)
![React 18](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![Properties 37](https://img.shields.io/badge/PBT-37%20Properties%20%2F%20147%20assertions-brightgreen)
![AI Native](https://img.shields.io/badge/AI%20Native-Kiro%20Spec%20Driven-blueviolet)
![License MIT](https://img.shields.io/badge/License-MIT-blue)

企业内部技术交流社区，深度集成 5 大 AI 能力（内容审核 / RAG 问答 / 代码解读 / 写作助手 / 智能推荐），同时通过 MCP Server 让外部 AI 助手反向调用社区，实现"双向 AI 原生"。

| 资源 | 链接 |
| --- | --- |
| 在线演示 | http://124.222.8.86 |
| Git 仓库 | https://github.com/greymon226/community |
| MCP HTTP 端点 | http://124.222.8.86/mcp |

---

## AI 原生亮点

| 维度 | 内容 |
| --- | --- |
| **Spec 三段式** | `requirements.md` (84 EARS) → `design.md` (37 Properties) → `tasks.md` |
| **Property 测试** | 37 条 Correctness Properties / 29 个 PBT 文件 / 147 个断言 / 0 失败 |
| **Kiro Hooks** | 4 个运行时 AI 守护：spec-sync / pbt-on-ai-change / secret-leak-guard / post-task-test |
| **MCP Server** | 4 个工具（search_posts / get_post / ask_community / recommend_posts），HTTP 端点公网可调 |
| **协作实录** | 8 个真实节点的 AI + 人类协作记录（在 `.kiro/specs/` 下） |
| **CI/CD** | GitHub Actions 自动跑 unit + property 测试 |

---

## 配套文档

| 文档 | 说明 |
| --- | --- |
| [`submission/01-设计文档.md`](submission/01-设计文档.md) | 10 章完整技术设计（项目概述 / 架构 / 详细设计 / AI 方案 / 测试方案 / 经验总结） |
| [`submission/02-演示材料.md`](submission/02-演示材料.md) | 7 分钟演示脚本 + Q&A + 评委可复现命令清单 |
| [`submission/03-AI协作关键决策.md`](submission/03-AI协作关键决策.md) | 23 条 AI 协作决策的人证物证 |
| [`backend/src/mcp/README.md`](backend/src/mcp/README.md) | MCP Server 启动方式（stdio / HTTP）+ 工具协议 |
| [`.kiro/hooks/README.md`](.kiro/hooks/README.md) | 4 个 Hook 的设计哲学 + 启用方式 |

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Node.js + Express + Sequelize（MySQL，可切 SQLite）+ JWT |
| 前端 | React 18 + Vite + Ant Design + Zustand + React Router |
| 缓存 | Redis（未配置时自动降级为内存 Map）|
| AI | DeepSeek（OpenAI 兼容协议）；调用失败自动降级到本地规则 |
| 认证 | CAS 单点登录（Mock 模式可本地账号密码登录）|
| 测试 | Node `--test` runner + fast-check（PBT）|
| 部署 | Docker Compose（生产）+ nginx 反代（统一 80 端口分流）|

---

## 快速启动

### 方式 1：完整 Docker 部署（推荐，与线上一致）

```bash
git clone https://github.com/greymon226/community
cd community

# 配置生产环境变量
cp deploy/.env.prod.example .env.prod
# 编辑 .env.prod：DB_PASS / JWT_SECRET / AI_API_KEY 等

# 一键启动 mysql + redis + backend + mcp + frontend
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d

# 灌种子数据
docker compose -f docker-compose.prod.yml exec backend node seed.js

# 访问
# 前端:     http://localhost
# API:      http://localhost/api
# MCP HTTP: http://localhost/mcp/tools
```

### 方式 2：本地开发模式

```bash
# 1. 仅起 MySQL + Redis
docker compose up -d

# 2. 后端（监听 4000）
cd backend
npm install
cp .env.example .env       # Windows 用 copy
npm run seed
npm run dev

# 3. 前端（监听 5173，反代 /api → :4000）
cd ../frontend
npm install
npm run dev

# 4. 跑全量测试
cd ../backend && npm test  # 224 pass (77 unit + 147 property)
```

### 默认账号（Mock CAS 模式）

| 角色 | 工号 | 密码 |
| --- | --- | --- |
| 超级管理员 | admin | admin123 |
| 版主 | mod001 | mod123 |
| 普通用户 | user001 | user123 |

> 生产环境对接真实 CAS 时无需密码。

---

## MCP Server（双向 AI 原生）

让外部 AI 助手反向调用社区能力 ——「项目用 AI」+「AI 用项目」双向闭环。

### 部署形态

```
公网 ──> nginx :80 ──> /api/* ──> backend:4000
                  └─> /mcp    ──> mcp:3001 (独立容器)
```

MCP 容器仅在 Docker 内部网络可达，对外只暴露 80 端口，与主站共用 SSL/域名。

### 在线接入（零安装）

`.kiro/settings/mcp.json` 或 Claude Desktop 配置贴入：

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

随后在 IDE 对话框输入「搜索社区里关于 React 的帖子」即可。

### curl 验证

```bash
curl http://124.222.8.86/mcp/tools

curl -X POST http://124.222.8.86/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"search_posts","arguments":{"keyword":"React"}}}'
```

详见 [`backend/src/mcp/README.md`](backend/src/mcp/README.md)。

---

## 测试

```bash
cd backend && npm test
```

`npm test` 跑：

- 77 个 unit tests（`tests/unit/`）
- 147 个 property assertions（`tests/property/`，29 个 PBT 文件覆盖 37 条 Property）

E2E 测试需要后端运行：

```bash
npm run start            # 终端 A
npm run test:e2e         # 终端 B（8 个 e2e 文件）
```

CI 状态：每次 push / PR 触发 [GitHub Actions](https://github.com/greymon226/community/actions)，约 2 分钟跑完。

---

## 项目结构

```
community/
├── .kiro/
│   ├── hooks/              ← 4 个 Kiro Hook（已启用）
│   ├── specs/tech-community-platform/
│   │   ├── requirements.md ← 27 需求 / 84 EARS AC
│   │   ├── design.md       ← 37 Properties + 架构设计
│   │   ├── tasks.md
│   │   └── ai-collaboration-log.md  ← 8 节点 AI 协作实录
│   └── settings/mcp.json   ← MCP Server 配置
├── .github/workflows/test.yml  ← CI
├── backend/
│   ├── src/
│   │   ├── config/         # 配置
│   │   ├── controllers/    # 控制器（auth / post / comment / ai / admin / ...）
│   │   ├── models/         # Sequelize 模型
│   │   ├── services/       # AI / Cache / CAS / Search / Moderation
│   │   ├── middlewares/    # auth / audit / error
│   │   ├── mcp/            ← MCP Server 实现
│   │   ├── routes/index.js
│   │   └── app.js
│   ├── tests/
│   │   ├── unit/           ← 77 unit tests
│   │   ├── property/       ← 29 PBT files / 147 assertions
│   │   ├── *.e2e.js        ← 8 e2e flows
│   │   └── run-suite.js    ← 跨平台测试 runner
│   └── seed.js
├── frontend/               # React SPA + nginx 反代配置
├── deploy/
│   ├── deploy.sh           # 一键部署 / 更新 / seed
│   └── README.md
├── docker-compose.yml       # 本地开发：MySQL + Redis
├── docker-compose.prod.yml  # 生产：mysql + redis + backend + mcp + frontend
├── submission/             # 竞赛提交材料（不进 ZIP）
└── README.md
```

---

## 端口速查

| 组件 | 容器内 | 主机暴露 |
| --- | --- | --- |
| frontend (nginx) | 80 | `${HTTP_PORT:-80}` |
| backend (Express) | 4000 | 不暴露（仅内部）|
| mcp (HTTP server) | 3001 | 不暴露（经 nginx /mcp 反代）|
| mysql | 3306 | 不暴露 |
| redis | 6379 | 不暴露 |

---

## License

MIT
