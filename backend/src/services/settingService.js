'use strict';

const { SystemSetting } = require('../models');

// 默认值定义；新增设置项请在此处声明，便于后台展示与默认初始化
const DEFAULTS = {
  aiAuditEnabled: { value: true, description: '发帖/评论是否走 AI 审核（默认开启）' },
  aiExplainEnabled: { value: true, description: '帖子详情是否启用 AI 解读功能（默认开启）' },
  aiExplainPerUserDailyLimit: { value: 30, description: '每个用户每天的 AI 解读次数上限' },
  aiAskEnabled: { value: true, description: '是否启用 AI 站内问答（基于站内帖子的 RAG）' },
  aiAskPerUserDailyLimit: { value: 50, description: '每个用户每天的 AI 问答次数上限' },
  aiAssistEnabled: { value: true, description: '是否启用 AI 写作助手（标题改写 / 摘要 / 代码解释）' },
  aiAssistPerUserDailyLimit: { value: 100, description: '每个用户每天的 AI 写作助手次数上限' },
};

let cache = null;

async function loadAll() {
  if (cache) return cache;
  const rows = await SystemSetting.findAll();
  cache = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const row = rows.find((r) => r.key === key);
    if (row) {
      try { cache[key] = JSON.parse(row.value); } catch { cache[key] = def.value; }
    } else {
      cache[key] = def.value;
    }
  }
  return cache;
}

function invalidate() {
  cache = null;
}

async function get(key) {
  const all = await loadAll();
  return all[key];
}

async function set(key, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    throw new Error(`未知的系统设置项: ${key}`);
  }
  const desc = DEFAULTS[key].description;
  const [row] = await SystemSetting.findOrCreate({
    where: { key },
    defaults: { key, value: JSON.stringify(value), description: desc },
  });
  row.value = JSON.stringify(value);
  row.description = desc;
  await row.save();
  invalidate();
  return value;
}

async function listForAdmin() {
  const all = await loadAll();
  return Object.entries(DEFAULTS).map(([key, def]) => ({
    key,
    value: all[key],
    description: def.description,
    defaultValue: def.value,
  }));
}

module.exports = { get, set, listForAdmin, invalidate, DEFAULTS };
