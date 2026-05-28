# 提交说明（README）

> AI 原生开发竞赛 · 打包与提交指南

---

## 1. 交付物清单

| 序号 | 交付物 | 文件/路径 | 说明 |
| --- | --- | --- | --- |
| 1 | 设计文档 | `submission/01-设计文档.md` | 10 章完整技术设计 |
| 2 | 演示材料 | `submission/02-演示材料.md` | PPT 脚本 + 评审辅助 |
| 3 | 源代码 ZIP | `submission/community-source.zip` | 含 .kiro/ 完整目录 |
| 4 | 线上演示环境 | http://124.222.8.86 | Docker Compose 部署 |
| 5 | Git 仓库 | https://github.com/greymon226/community | 含完整提交历史 |

---

## 2. 打包 ZIP 说明

### 2.1 Windows (PowerShell)

```powershell
# 在项目根目录执行
.\submission\pack-source.ps1
# 输出: submission/community-source.zip
```

或手动打包：

```powershell
# 排除 node_modules 和 .git
$exclude = @('node_modules', '.git', '*.zip')
Compress-Archive -Path .\ -DestinationPath .\submission\community-source.zip -Force
```

### 2.2 Linux / macOS (Bash)

```bash
# 在项目根目录执行
bash submission/pack-source.sh
# 输出: submission/community-source.zip
```

或手动打包：

```bash
zip -r submission/community-source.zip . \
  -x "node_modules/*" \
  -x ".git/*" \
  -x "*.zip"
```

### 2.3 ZIP 必须包含的目录/文件

```
community-source.zip
├── .kiro/
│   ├── hooks/                    ← 4 个 Kiro Hook（已启用）
│   │   ├── spec-sync-check.kiro.hook
│   │   ├── pbt-on-ai-change.kiro.hook
│   │   ├── secret-leak-guard.kiro.hook
│   │   └── post-task-test.kiro.hook
│   ├── specs/tech-community-platform/
│   │   ├── requirements.md       ← 27 需求 / 84 AC
│   │   ├── design.md             ← 37 Properties
│   │   ├── tasks.md              ← 任务清单
│   │   └── ai-collaboration-log.md ← 8 节点协作实录
│   └── settings/
│       └── mcp.json              ← MCP Server 配置
├── .github/
│   └── workflows/
│       └── test.yml              ← CI 配置（push/PR 自动跑 unit + property）
├── backend/
│   ├── src/
│   │   ├── mcp/                  ← MCP Server 实现
│   │   ├── services/aiService.js ← AI 核心服务
│   │   └── ...
│   └── tests/
│       └── property/             ← 29 个可执行 PBT 文件，覆盖 37 条 Property
│           ├── P02-*.test.js
│           ├── ...
│           └── P37-prompt-injection-detection.test.js
├── frontend/
├── docker-compose.yml
└── README.md
```

> 注：`submission/` 下的 `01-设计文档.md` / `02-演示材料.md` / `README-提交说明.md` 不进 ZIP，作为独立 PDF 单独提交。

---

## 3. 导出 PDF 方法

如需将 Markdown 文档导出为 PDF，推荐以下 4 种方法：

### 方法 1：VS Code 插件（推荐）

1. 安装 [Markdown PDF](https://marketplace.visualstudio.com/items?itemName=yzane.markdown-pdf) 插件
2. 打开 `.md` 文件
3. `Ctrl+Shift+P` → "Markdown PDF: Export (pdf)"
4. 自动生成同名 `.pdf` 文件

### 方法 2：Typora

1. 用 Typora 打开 `.md` 文件
2. 文件 → 导出 → PDF
3. 支持 Mermaid 图表渲染

### 方法 3：Pandoc 命令行

```bash
# 安装 pandoc + wkhtmltopdf
pandoc 01-设计文档.md -o 01-设计文档.pdf \
  --pdf-engine=wkhtmltopdf \
  --css=github-markdown.css
```

### 方法 4：浏览器打印

1. 用支持 Mermaid 的 Markdown 预览器打开（如 GitHub）
2. `Ctrl+P` → 选择"另存为 PDF"
3. 注意：Mermaid 图可能需要手动截图

---

## 4. 最终提交 Checklist

### 4.1 链接检查

- [ ] 线上演示环境 URL 可访问：http://124.222.8.86
- [ ] Git 仓库 URL 可克隆：https://github.com/greymon226/community
- [ ] 评审账号已创建且可登录

### 4.2 ZIP 内容检查

- [ ] `.kiro/hooks/` 目录包含 4 个 Hook 文件
- [ ] `.kiro/specs/tech-community-platform/` 包含 4 个 Spec 文件
- [ ] `.kiro/specs/tech-community-platform/ai-collaboration-log.md` 有 8 个节点
- [ ] `backend/src/mcp/index.js` MCP Server 实现存在
- [ ] `backend/tests/property/` 包含 29 个可执行 PBT 文件，覆盖 P02-P18、P23、P27-P37
- [ ] `backend/tests/property/P37-prompt-injection-detection.test.js` 存在
- [ ] `.github/workflows/test.yml` CI 配置存在
- [ ] `docker-compose.yml` 存在
- [ ] 无 `node_modules/` 目录（已排除）
- [ ] 无 `.git/` 目录（已排除）
- [ ] 无 `.env` 中的真实密钥（检查是否为 `.env.example`）

### 4.3 文档检查

- [ ] `01-设计文档.md` 10 章完整
- [ ] `02-演示材料.md` 7 节完整
- [ ] 所有 Mermaid 图可渲染
- [ ] 错误码表包含 4005（Prompt Injection）
- [ ] Property 数量统一为 37 条（含 P37）
- [ ] MCP Server 作为亮点突出体现

### 4.4 演示环境检查

- [ ] Docker Compose 可一键启动
- [ ] 演示数据已 seed（≥ 10 篇帖子）
- [ ] AI 功能可用（DeepSeek API Key 有效）
- [ ] Redis 降级可演示（`docker stop redis` 后系统正常）
- [ ] Prompt Injection 演示可复现（输入注入串 → 返回 4005）
- [ ] **MCP HTTP 端点可访问**：`curl http://124.222.8.86/mcp/tools` 返回 4 个工具
- [ ] **MCP 真实调用可复现**：`curl -X POST http://124.222.8.86/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_posts","arguments":{"keyword":"React"}}}'` 返回帖子列表

### 4.5 加分项检查

- [ ] Kiro Hook 4 个配置文件已启用（`.kiro.hook` 后缀）
- [ ] MCP Server 4 个工具可在 IDE 中调用
- [ ] AI 协作实录 8 个节点有真实技术细节
- [ ] P37 Prompt Injection 作为安全亮点
- [ ] `.github/workflows/test.yml` CI 配置完整
- [ ] 混沌工程 8 场景演练结果

---

## 5. 竞赛要求映射表

| 竞赛评审维度 | 本项目对应内容 | 所在章节 |
| --- | --- | --- |
| AI 原生开发过程 | Kiro Spec 三段式 + 8 节点协作实录 | 设计文档 §7、演示材料 §2 |
| AI 技术应用 | 5 大 AI 特性 + MCP Server | 设计文档 §6、演示材料 §2.4 |
| 需求管理 | 27 需求 / 84 条 EARS AC | 设计文档 §3 |
| 设计质量 | 37 条 Correctness Properties | 设计文档 §5-§6 |
| 测试完备性 | 29 个可执行 PBT + 8 E2E，147 断言全通过 | 设计文档 §9 |
| 安全防护 | P37 Prompt Injection + 安全矩阵 | 设计文档 §8.2 |
| 降级与可靠性 | 三重降级 + 混沌演练 8 场景 | 设计文档 §8.3-§8.4 |
| 工程实践 | Kiro Hooks（已启用）+ GitHub Actions CI + Docker | 设计文档 §7.4 |
| 创新性 | 双向 AI 原生（MCP Server） | 演示材料 §2.8 |
| 代码质量 | Property 守护 + Hook 持续验证 | 设计文档 §7.5 |
| 文档完整性 | 设计文档 + 演示材料 + 提交说明 | 本文件 §1 |
| 可复现性 | Docker Compose + seed 脚本 | 设计文档 §4.3 |

---

## 快速启动（评审用）

### 方式 1：完整 Docker 部署（推荐，与线上一致）

```bash
# 1. 克隆仓库
git clone https://github.com/greymon226/community
cd community

# 2. 配置生产环境变量
cp deploy/.env.prod.example .env.prod
# 按需编辑 .env.prod（DB_PASS / JWT_SECRET / AI_API_KEY 等）

# 3. 一键启动（mysql + redis + backend + mcp + frontend nginx）
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d

# 4. 等待服务就绪（约 30s）
docker compose -f docker-compose.prod.yml logs -f backend
# 看到 "[community-backend] listening on http://localhost:4000" 即可

# 5. 灌种子数据
docker compose -f docker-compose.prod.yml exec backend node seed.js

# 6. 访问（nginx 统一在 80 端口分流）
# 前端:        http://localhost
# API:         http://localhost/api
# MCP HTTP:    http://localhost/mcp/tools
```

### 方式 2：本地开发模式

```bash
# 1. 仅起 MySQL + Redis 容器
docker compose up -d

# 2. 后端（监听 4000）
cd backend
npm install
copy .env.example .env
npm run seed
npm run dev               # http://localhost:4000

# 3. 前端（Vite dev server，监听 5173，反代 /api → :4000）
cd ../frontend
npm install
npm run dev               # http://localhost:5173

# 4. 跑全量测试（含 29 个可执行 PBT 文件）
cd ../backend && npm test
```

### 端口速查

| 组件 | 容器内端口 | 主机暴露 |
| --- | --- | --- |
| frontend (nginx) | 80 | `${HTTP_PORT:-80}` |
| backend (express) | 4000 | 不暴露（仅内部网络） |
| mcp (HTTP server) | 3001 | 不暴露（经 nginx /mcp 反代） |
| mysql | 3306 | 不暴露 |
| redis | 6379 | 不暴露 |

---

> 如有疑问请联系项目负责人。
> 最后更新：2025 年 · AI 原生开发竞赛
