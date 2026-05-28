# Community Platform MCP Server

> 把社区核心能力暴露为 MCP（Model Context Protocol）工具，
> 让外部 AI 助手（Claude Desktop / Kiro / Cursor 等）可以直接"问站内"。

## 为什么做 MCP

本项目不仅**自身深度使用 AI**（审核 / 推荐 / 解读 / 问答 / 写作助手），
还能**被 AI 调用** — 这是 *AI 原生* 的双向标志：

- 单向 AI 原生：项目用 AI → 大多数参赛作品的水平
- **双向 AI 原生**：项目用 AI + AI 用项目 → 本平台独有的差异化

## 暴露的 4 个工具

| 工具名 | 用途 | 典型 Prompt |
| --- | --- | --- |
| `search_posts` | 全文搜索帖子 | "帮我搜一下社区里关于 React hooks 的帖子" |
| `get_post` | 获取帖子完整内容 | "把帖子 42 的内容拿给我看看" |
| `ask_community` | 站内 RAG 问答 | "公司内部 Node.js 怎么做连接池优化？" |
| `recommend_posts` | 标签推荐帖子 | "给我推荐 React 和 TypeScript 相关的帖子" |

## 启动方式

本 MCP Server 支持两种传输模式：

### 模式 A：stdio（本地 IDE 自动管理）

适合开发期、本机调试。IDE 启动时 spawn 一个 Node 进程，通过 stdin/stdout 通信。

```bash
cd backend
node src/mcp/index.js   # 默认 stdio 模式
```

启动后 stderr 输出 `[MCP] Community Platform MCP server ready`。

`.kiro/settings/mcp.json` 本地配置示例：

```json
{
  "mcpServers": {
    "community-platform-local": {
      "command": "node",
      "args": ["backend/src/mcp/index.js"],
      "autoApprove": ["search_posts", "get_post", "recommend_posts"]
    }
  }
}
```

### 模式 B：HTTP（生产 / 远程接入）

适合线上部署、给评委或外部 AI 客户端使用。监听 HTTP JSON-RPC 端点。

```bash
node src/mcp/index.js --http
# 默认监听 0.0.0.0:3001，可通过环境变量调整：
#   MCP_HOST=0.0.0.0
#   MCP_PORT=3001
```

提供两个端点：

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/tools` | GET | 列出所有工具（供 curl/调试用） |
| `/` | POST | JSON-RPC 2.0 标准入口 |

### 生产部署（docker-compose.prod.yml）

线上以独立 `mcp` 容器运行 HTTP 模式，由 frontend nginx 反代 `/mcp` 路径，对外不暴露 3001。

```
公网 ──> nginx :80 ──> /api/* ──> backend:4000
                  └─> /mcp    ──> mcp:3001 (独立容器，仅内部网络)
```

线上接入配置（评委侧）：

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

curl 实测：

```bash
curl http://124.222.8.86/mcp/tools
curl -X POST http://124.222.8.86/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_posts","arguments":{"keyword":"React"}}}'
```

## 前置条件

- 后端依赖已安装（`cd backend && npm install`）
- MySQL + Redis 已启动（或用 sqlite 模式）
- `backend/.env` 已配置（至少 DB 连接串）

## 安全

- `ask_community` 工具会消耗用户的 AI 配额（与 Web 端共享）
- stdio 模式仅本地 IDE 可访问，不暴露网络端口
- HTTP 模式生产部署时通过 nginx 反代 `/mcp` 路径，3001 端口不绑定主机
- `autoApprove` 里没有 `ask_community`（它会调 LLM），需要人工确认

## 演示脚本

在 Kiro IDE 对话框中直接输入：

> 帮我搜索社区里关于 "useEffect 闭包" 的帖子

Kiro 会自动识别到 `search_posts` 工具并调用，返回匹配帖子列表。

> 公司内部 Docker 部署的最佳实践是什么？

Kiro 会调用 `ask_community`，基于站内帖子回答并标注引用。
