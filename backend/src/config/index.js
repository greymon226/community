'use strict';

require('dotenv').config();
const path = require('path');

const config = {
  port: parseInt(process.env.PORT || '4000', 10),

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  db: {
    // 默认 mysql（纯 JS 驱动，无需编译）。可改为 sqlite 进行单机开发
    dialect: process.env.DB_DIALECT || 'mysql',
    storage: process.env.DB_STORAGE || path.resolve(__dirname, '../../data/community.sqlite'),
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3316', 10),
    name: process.env.DB_NAME || 'community',
    user: process.env.DB_USER || 'root',
    pass: process.env.DB_PASS || 'community123',
  },

  redisUrl: process.env.REDIS_URL || null,

  publicBaseUrl: process.env.PUBLIC_BASE_URL || (
    process.env.PUBLIC_DOMAIN ? `http://${process.env.PUBLIC_DOMAIN}` : 'http://localhost'
  ),

  mcp: {
    apiKey: process.env.MCP_API_KEY || '',
  },

  cas: {
    serverUrl: process.env.CAS_SERVER_URL || null,
    serviceUrl: process.env.CAS_SERVICE_URL || null,
    mock: !process.env.CAS_SERVER_URL,
    attrs: {
      empNo: process.env.CAS_ATTR_EMP_NO || 'empNo,employeeNumber,uid,user',
      name: process.env.CAS_ATTR_NAME || 'name,displayName,cn',
      email: process.env.CAS_ATTR_EMAIL || 'email,mail',
      department: process.env.CAS_ATTR_DEPARTMENT || 'department,departmentName,dept',
      avatar: process.env.CAS_ATTR_AVATAR || 'avatar,picture',
    },
  },

  upload: {
    dir: process.env.UPLOAD_DIR || path.resolve(__dirname, '../../uploads'),
    maxMb: parseInt(process.env.MAX_UPLOAD_MB || '10', 10),
  },

  sensitiveWords: (process.env.SENSITIVE_WORDS || '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean),

  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    // 前端 GitHub 回调页面完整地址，用于构建 OAuth 授权 URL 的 redirect_uri
    callbackUrl: process.env.GITHUB_CALLBACK_URL || 'http://localhost:5173/login/github-callback',
  },

  ai: {
    provider: process.env.AI_PROVIDER || 'local', // local | deepseek | openai
    apiKey: process.env.AI_API_KEY || '',
    baseUrl: process.env.AI_BASE_URL || 'https://api.deepseek.com',
    model: process.env.AI_MODEL || 'deepseek-chat',
    timeoutMs: parseInt(process.env.AI_TIMEOUT_MS || '15000', 10),
  },
};

module.exports = config;
