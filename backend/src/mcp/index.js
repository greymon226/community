'use strict';

// ============================================================
// Community Platform — MCP Server
//
// 把社区核心能力暴露为 Model Context Protocol 工具，
// 让外部 AI 助手（Claude Desktop / Kiro / Cursor 等）可以
// 直接"问站内"——实现"被 AI 调用"的双向 AI 原生。
//
// 启动方式：
//   node backend/src/mcp/index.js          # 独立进程（stdio 模式）
//   或通过 mcp.json 配置让 IDE 自动管理
//
// 协议：MCP over stdio（jsonrpc 2.0）
//   - 支持 tools/list → 返回工具定义
//   - 支持 tools/call → 执行工具并返回结果
//
// 暴露的 4 个工具：
//   1. search_posts   — 全文搜索帖子
//   2. get_post       — 获取帖子详情
//   3. ask_community  — 站内 RAG 问答（非流式）
//   4. recommend_posts — 基于标签推荐帖子
// ============================================================

const readline = require('readline');
const path = require('path');
const crypto = require('crypto');

// 在 MCP 进程中加载 .env 配置
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// 延迟加载业务模块（它们依赖 config，config 依赖 env）
let search, ai, models, cache, config;

async function bootstrap() {
  config = require('../config');
  models = require('../models');
  cache = require('../services/cacheService');
  search = require('../services/searchService');
  ai = require('../services/aiService');

  await models.sequelize.authenticate();
  await models.sequelize.sync();
  await cache.init();
}

function publicUrl(pathname) {
  const base = (config?.publicBaseUrl || process.env.PUBLIC_BASE_URL || 'http://localhost').replace(/\/+$/, '');
  return `${base}${pathname}`;
}

function isAuthorized(req) {
  const apiKey = config?.mcp?.apiKey || process.env.MCP_API_KEY || '';
  if (!apiKey) return true;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const headerKey = req.headers['x-mcp-api-key'] || '';
  return safeEqual(bearer, apiKey) || safeEqual(headerKey, apiKey);
}

function safeEqual(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string') return false;
  const inputBytes = Buffer.from(input);
  const expectedBytes = Buffer.from(expected);
  if (inputBytes.length !== expectedBytes.length) return false;
  return crypto.timingSafeEqual(inputBytes, expectedBytes);
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

// ---- Tool Definitions ----

const TOOLS = [
  {
    name: 'search_posts',
    description: '在企业技术社区中全文搜索帖子。支持按关键词、分类、标签筛选，按时间/热度/评论排序。返回帖子列表（标题、摘要、作者、分类、点赞数）。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词（在标题、正文、摘要中 OR 匹配）' },
        categoryId: { type: 'number', description: '板块 ID，可选' },
        tag: { type: 'string', description: '标签名过滤，可选' },
        sort: { type: 'string', enum: ['latest', 'hot', 'comments', 'featured'], description: '排序方式，默认 latest' },
        page: { type: 'number', description: '页码，默认 1' },
        pageSize: { type: 'number', description: '每页条数，默认 10，最大 50' },
      },
      required: [],
    },
  },
  {
    name: 'get_post',
    description: '获取社区中某篇帖子的完整内容（标题、正文纯文本、作者、分类、标签、点赞数、评论数）。',
    inputSchema: {
      type: 'object',
      properties: {
        postId: { type: 'number', description: '帖子 ID' },
      },
      required: ['postId'],
    },
  },
  {
    name: 'ask_community',
    description: '基于站内已有帖子回答技术问题（RAG 模式）。系统会检索最相关的帖子作为上下文，让 AI 仅基于站内内容回答并标注引用。适合问"公司内部怎么做 X"类问题。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '用户的技术问题（不超过 500 字）' },
        topN: { type: 'number', description: '召回帖子数，3-8，默认 5' },
      },
      required: ['question'],
    },
  },
  {
    name: 'recommend_posts',
    description: '基于给定的技术标签推荐社区帖子。如果不提供标签则返回热门帖。',
    inputSchema: {
      type: 'object',
      properties: {
        techTags: {
          type: 'array',
          items: { type: 'string' },
          description: '技术标签列表，如 ["React", "Node.js", "MySQL"]',
        },
        limit: { type: 'number', description: '返回条数，默认 10' },
      },
      required: [],
    },
  },
];

// ---- Tool Execution ----

async function executeTool(name, args) {
  switch (name) {
    case 'search_posts': {
      const { keyword, categoryId, tag, sort, page, pageSize } = args || {};
      const result = await search.searchPosts({
        keyword: keyword || '',
        categoryId: categoryId || undefined,
        tag: tag || undefined,
        sort: sort || 'latest',
        page: page || 1,
        pageSize: Math.min(pageSize || 10, 50),
      });
      // 精简输出，避免超长
      const items = result.items.map((p) => ({
        id: p.id,
        title: p.title,
        summary: (p.summary || '').slice(0, 200),
        author: p.author?.nickname || p.author?.name || '-',
        category: p.category?.name || '-',
        tags: (p.tags || []).map((t) => t.name),
        likeCount: p.likeCount,
        commentCount: p.commentCount,
        createdAt: p.createdAt,
      }));
      return { total: result.total, page: result.page, pageSize: result.pageSize, items };
    }

    case 'get_post': {
      const { Post, User, Category, Tag } = models;
      const post = await Post.findByPk(args.postId, {
        include: [
          { model: User, as: 'author', attributes: ['id', 'nickname', 'name', 'department'] },
          { model: Category, as: 'category', attributes: ['id', 'name'] },
          { association: 'tags', attributes: ['id', 'name'] },
        ],
      });
      if (!post || post.status !== 'published') {
        return { error: '帖子不存在' };
      }
      // 去掉 HTML 标签只保留纯文本
      const { cleanPlainText } = require('../utils/sanitize');
      return {
        id: post.id,
        title: post.title,
        content: cleanPlainText(post.content || '').slice(0, 8000),
        summary: post.summary,
        author: post.author?.nickname || post.author?.name || '-',
        department: post.author?.department || '-',
        category: post.category?.name || '-',
        tags: (post.tags || []).map((t) => t.name),
        likeCount: post.likeCount,
        commentCount: post.commentCount,
        viewCount: post.viewCount,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
      };
    }

    case 'ask_community': {
      const { question, topN } = args || {};
      if (!question || question.length > 500) {
        return { error: '问题不能为空且不超过 500 字' };
      }
      const n = Math.min(8, Math.max(3, topN || 5));
      const sources = await search.searchForRAG(question, { topN: n });
      const result = await ai.askWithRAG(question, sources);
      return {
        question,
        answer: result.answer,
        hasAnswer: result.hasAnswer,
        citations: sources
          .filter((s) => (result.citedSourceIds || []).includes(s.id))
          .map((s) => ({ id: s.id, title: s.title })),
        candidates: sources.map((s) => ({ id: s.id, title: s.title })),
      };
    }

    case 'recommend_posts': {
      const { techTags, limit } = args || {};
      const mockUser = { techTags: Array.isArray(techTags) ? techTags.join(',') : '' };
      const posts = await ai.recommendPosts(mockUser, limit || 10);
      return posts.map((p) => ({
        id: p.id,
        title: p.title,
        summary: (p.summary || '').slice(0, 200),
        likeCount: p.likeCount,
        tags: (p.tags || []).map((t) => t.name),
      }));
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---- Format MCP Tool Response for human readability ----
function formatToolOutput(name, result) {
  if (!result) return '无返回结果';
  if (result.error) return `❌ 错误: ${result.error}`;

  switch (name) {
    case 'search_posts': {
      const { total, page, pageSize, items } = result;
      if (!items || items.length === 0) {
        return `🔍 社区搜索结果 (共 0 条)\n==================================================\n未找到匹配的帖子。`;
      }
      const totalPages = Math.ceil(total / pageSize);
      let text = `🔍 社区搜索结果 (共 ${total} 条，当前第 ${page}/${totalPages} 页)\n`;
      text += `==================================================\n\n`;
      items.forEach((p, idx) => {
        text += `${idx + 1}. 【${p.title}】 (ID: ${p.id})\n`;
        text += `   分类: ${p.category} | 作者: ${p.author} | 发布时间: ${p.createdAt ? new Date(p.createdAt).toLocaleString('zh-CN', { hour12: false }) : '-'}\n`;
        text += `   互动: 👍 ${p.likeCount} 点赞 | 💬 ${p.commentCount} 评论\n`;
        text += `   标签: ${p.tags && p.tags.length > 0 ? p.tags.join(', ') : '无'}\n`;
        text += `   摘要: ${p.summary || '无'}\n`;
        text += `   详情链接: ${publicUrl(`/post/${p.id}`)}\n`;
        text += `--------------------------------------------------\n`;
      });
      return text.trim();
    }
    case 'get_post': {
      const p = result;
      let text = `📝 帖子详情: 【${p.title}】 (ID: ${p.id})\n`;
      text += `==================================================\n`;
      text += `分类: ${p.category} | 作者: ${p.author} (${p.department || '-'})\n`;
      text += `发布: ${p.createdAt ? new Date(p.createdAt).toLocaleString('zh-CN', { hour12: false }) : '-'} | 更新: ${p.updatedAt ? new Date(p.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}\n`;
      text += `数据: 👍 ${p.likeCount} 点赞 | 💬 ${p.commentCount} 评论 | 👁️ ${p.viewCount} 阅读\n`;
      text += `标签: ${p.tags && p.tags.length > 0 ? p.tags.join(', ') : '无'}\n`;
      text += `==================================================\n\n`;
      text += `${p.content}\n`;
      return text.trim();
    }
    case 'ask_community': {
      const { question, answer, hasAnswer, citations } = result;
      let text = `🤖 社区 AI 问答结果\n`;
      text += `==================================================\n`;
      text += `问题: ${question}\n`;
      text += `回答:\n${answer}\n\n`;
      if (citations && citations.length > 0) {
        text += `引用文献/帖子:\n`;
        citations.forEach((c) => {
          text += `  - 【${c.title}】 (${publicUrl(`/posts/${c.id}`)})\n`;
        });
      } else {
        text += `没有直接引用的站内帖子。\n`;
      }
      text += `==================================================`;
      return text.trim();
    }
    case 'recommend_posts': {
      if (!Array.isArray(result) || result.length === 0) {
        return `👍 社区推荐帖子\n==================================================\n暂无推荐。`;
      }
      let text = `👍 社区推荐帖子 (共 ${result.length} 条)\n`;
      text += `==================================================\n\n`;
      result.forEach((p, idx) => {
        text += `${idx + 1}. 【${p.title}】 (ID: ${p.id})\n`;
        text += `   互动: 👍 ${p.likeCount} 点赞\n`;
        text += `   标签: ${p.tags && p.tags.length > 0 ? p.tags.join(', ') : '无'}\n`;
        text += `   摘要: ${p.summary || '无'}\n`;
        text += `   详情链接: ${publicUrl(`/post/${p.id}`)}\n`;
        text += `--------------------------------------------------\n`;
      });
      return text.trim();
    }
    default:
      return JSON.stringify(result, null, 2);
  }
}

// ---- MCP Protocol Handler (stdio, jsonrpc 2.0) ----

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let buffer = '';

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'community-platform-mcp', version: '1.0.0' },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    // Client acknowledged — no response needed
    return;
  }

  if (method === 'tools/list') {
    sendResponse(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    try {
      const result = await executeTool(toolName, toolArgs);
      sendResponse(id, {
        content: [{ type: 'text', text: formatToolOutput(toolName, result) }],
      });
    } catch (e) {
      sendResponse(id, {
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true,
      });
    }
    return;
  }

  // Unknown method
  if (id) sendError(id, -32601, `Method not found: ${method}`);
}

// ---- Main ----
const MODE = process.argv.includes('--http') ? 'http' : 'stdio';
const HTTP_PORT = parseInt(process.env.MCP_PORT || '3001', 10);

if (MODE === 'http') {
  // ============================================================
  // HTTP 传输模式 — 部署到服务器后外部 AI 通过网络调用
  //
  // 启动：node backend/src/mcp/index.js --http
  // 端口：MCP_PORT 环境变量，默认 3001
  //
  // 接口：
  //   POST /mcp  — JSON-RPC 2.0 请求（与 stdio 模式相同的协议）
  //   GET  /mcp/tools — 快捷查看工具列表（便于调试）
  //
  // 外部 AI 配置示例（mcp.json）：
  //   { "mcpServers": { "community": { "url": "https://community.example.com/mcp" } } }
  // ============================================================
  const http = require('http');

  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-mcp-api-key');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (!isAuthorized(req)) {
      writeJson(res, 401, { error: 'Unauthorized MCP request' });
      return;
    }

    // GET /mcp/tools — 便捷调试
    if (req.method === 'GET' && req.url === '/mcp/tools') {
      writeJson(res, 200, { tools: TOOLS });
      return;
    }

    // POST /mcp — JSON-RPC 2.0
    if (req.method === 'POST' && req.url === '/mcp') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        let msg;
        try { msg = JSON.parse(body); } catch {
          writeJson(res, 400, { error: 'Invalid JSON' });
          return;
        }

        const { id, method, params } = msg;
        let response;

        if (method === 'initialize') {
          response = {
            jsonrpc: '2.0', id, result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'community-platform-mcp', version: '1.0.0' },
            }
          };
        } else if (method === 'tools/list') {
          response = { jsonrpc: '2.0', id, result: { tools: TOOLS } };
        } else if (method === 'tools/call') {
          const toolName = params?.name;
          const toolArgs = params?.arguments || {};
          try {
            const result = await executeTool(toolName, toolArgs);
            response = {
              jsonrpc: '2.0', id, result: {
                content: [{ type: 'text', text: formatToolOutput(toolName, result) }],
              }
            };
          } catch (e) {
            response = {
              jsonrpc: '2.0', id, result: {
                content: [{ type: 'text', text: `Error: ${e.message}` }],
                isError: true,
              }
            };
          }
        } else {
          response = { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
        }

        writeJson(res, 200, response);
      });
      return;
    }

    res.writeHead(404);
    res.end('Not Found. Use POST /mcp or GET /mcp/tools');
  });

  bootstrap()
    .then(() => {
      server.listen(HTTP_PORT, () => {
        console.log(`[MCP-HTTP] Community Platform MCP server listening on http://0.0.0.0:${HTTP_PORT}/mcp`);
        console.log(`[MCP-HTTP] Tools list: http://0.0.0.0:${HTTP_PORT}/mcp/tools`);
      });
    })
    .catch((err) => {
      console.warn(`[MCP-HTTP] Bootstrap warning: ${err.message} - server starting anyway`);
      server.listen(HTTP_PORT, () => {
        console.log(`[MCP-HTTP] Server listening (DB unavailable) on http://0.0.0.0:${HTTP_PORT}/mcp`);
      });
    });

} else {
  // ---- stdio 模式（本地 IDE 用）----
  // Parse Content-Length framed messages from stdin
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + len) break;
      const body = buffer.slice(bodyStart, bodyStart + len);
      buffer = buffer.slice(bodyStart + len);
      handleMessage(body);
    }
  });

  bootstrap()
    .then(() => {
      process.stderr.write('[MCP] Community Platform MCP server ready (stdio)\n');
    })
    .catch((err) => {
      process.stderr.write(`[MCP] Bootstrap warning: ${err.message} - server will start but tools may fail\n`);
    });
}
