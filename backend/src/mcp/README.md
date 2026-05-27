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

### 1. IDE 自动管理（推荐）

在 Kiro / VS Code + MCP 插件中，`.kiro/settings/mcp.json` 已配置好：

```json
{
  "mcpServers": {
    "community-platform": {
      "command": "node",
      "args": ["backend/src/mcp/index.js"],
      "disabled": false,
      "autoApprove": ["search_posts", "get_post", "recommend_posts"]
    }
  }
}
```

IDE 会自动启动 MCP server 进程，无需手动操作。

### 2. 手动启动（调试用）

```bash
cd backend
node src/mcp/index.js
```

进程启动后在 stderr 输出 `[MCP] Community Platform MCP server ready`，
然后等待 stdin 上的 JSON-RPC 消息。

## 前置条件

- 后端依赖已安装（`cd backend && npm install`）
- MySQL + Redis 已启动（或用 sqlite 模式）
- `backend/.env` 已配置（至少 DB 连接串）

## 安全

- `ask_community` 工具会消耗用户的 AI 配额（与 Web 端共享）
- MCP server 在 **stdio 模式** 运行，仅本地 IDE 可访问，不暴露网络端口
- `autoApprove` 里没有 `ask_community`（它会调 LLM），需要人工确认

## 演示脚本

在 Kiro IDE 对话框中直接输入：

> 帮我搜索社区里关于 "useEffect 闭包" 的帖子

Kiro 会自动识别到 `search_posts` 工具并调用，返回匹配帖子列表。

> 公司内部 Docker 部署的最佳实践是什么？

Kiro 会调用 `ask_community`，基于站内帖子回答并标注引用。
