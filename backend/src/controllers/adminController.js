'use strict';

const { User, Post, Comment, Category, Report, AuditLog, SensitiveWord } = require('../models');
const { ok, fail } = require('../utils/response');
const moderation = require('../services/moderationService');
const settings = require('../services/settingService');
const { writeAudit } = require('../middlewares/audit');

// GET /admin/stats
async function stats(_req, res) {
  const [users, posts, comments, categories, pendingReports] = await Promise.all([
    User.count(),
    Post.count({ where: { status: 'published' } }),
    Comment.count({ where: { status: 'active' } }),
    Category.count(),
    Report.count({ where: { status: 'pending' } }),
  ]);
  return ok(res, { users, posts, comments, categories, pendingReports });
}

// GET /admin/ai-stats
async function aiStats(_req, res) {
  const aiMetrics = require('../services/aiMetricsService');
  const data = await aiMetrics.getAdminStats(7);
  return ok(res, data);
}

// GET /admin/users
async function listUsers(req, res) {
  const { page = 1, pageSize = 20, keyword } = req.query;
  const where = {};
  if (keyword) {
    const { Op } = require('sequelize');
    where[Op.or] = [
      { name: { [Op.like]: `%${keyword}%` } },
      { empNo: { [Op.like]: `%${keyword}%` } },
      { department: { [Op.like]: `%${keyword}%` } },
    ];
  }
  const offset = (page - 1) * pageSize;
  const { rows, count } = await User.findAndCountAll({
    where,
    offset,
    limit: +pageSize,
    order: [['id', 'ASC']],
    attributes: { exclude: ['passwordHash'] },
  });
  return ok(res, { items: rows, total: count });
}

// PUT /admin/users/:id/role  body: { role, moderatorCategoryIds }
async function updateUserRole(req, res) {
  const u = await User.findByPk(req.params.id);
  if (!u) return fail(res, '用户不存在', 404, 404);
  const { role, moderatorCategoryIds, status } = req.body || {};
  if (role && ['user', 'moderator', 'admin'].includes(role)) u.role = role;
  if (moderatorCategoryIds !== undefined) {
    u.moderatorCategoryIds = JSON.stringify(Array.isArray(moderatorCategoryIds) ? moderatorCategoryIds : []);
  }
  if (status && ['active', 'disabled'].includes(status)) u.status = status;
  await u.save();
  await writeAudit(req, { action: 'user.update', targetType: 'user', targetId: u.id, detail: { role: u.role, status: u.status } });
  return ok(res, u);
}

// GET /admin/sensitive-words
async function listWords(_req, res) {
  const list = await SensitiveWord.findAll({ order: [['id', 'ASC']] });
  return ok(res, list);
}

// POST /admin/sensitive-words
async function addWord(req, res) {
  const { word, strategy = 'mask' } = req.body || {};
  if (!word) return fail(res, '词不能为空');
  const [w, created] = await SensitiveWord.findOrCreate({
    where: { word },
    defaults: { strategy },
  });
  if (!created) {
    w.strategy = strategy;
    await w.save();
  }
  moderation.invalidate();
  return ok(res, w);
}

// DELETE /admin/sensitive-words/:id
async function deleteWord(req, res) {
  const w = await SensitiveWord.findByPk(req.params.id);
  if (!w) return fail(res, '不存在', 404, 404);
  await w.destroy();
  moderation.invalidate();
  return ok(res, null, '已删除');
}

// GET /admin/audit-logs
async function listAudits(req, res) {
  const { page = 1, pageSize = 50 } = req.query;
  const offset = (page - 1) * pageSize;
  const { rows, count } = await AuditLog.findAndCountAll({
    offset,
    limit: +pageSize,
    order: [['createdAt', 'DESC']],
    include: [{ association: 'operator', attributes: ['id', 'nickname', 'name', 'empNo'] }],
  });
  return ok(res, { items: rows, total: count });
}

// GET /admin/settings
async function listSettings(_req, res) {
  const items = await settings.listForAdmin();
  // 附带 AI provider 状态
  const aiStatus = {
    provider: require('../config').ai.provider,
    model: require('../config').ai.model,
    apiKeyConfigured: !!require('../config').ai.apiKey,
  };
  return ok(res, { items, aiStatus });
}

// PUT /admin/settings  body: { key, value }
async function updateSetting(req, res) {
  const { key, value } = req.body || {};
  if (!key) return fail(res, '缺少 key');
  try {
    const v = await settings.set(key, value);
    await writeAudit(req, { action: 'setting.update', targetType: 'setting', detail: { key, value: v } });
    return ok(res, { key, value: v });
  } catch (e) {
    return fail(res, e.message, 400);
  }
}

// POST /admin/ai/test  body: { title?, content? }
// 用真实样本调用一次 AI 审核，便于自检 DeepSeek 是否连通
async function testAi(req, res) {
  const ai = require('../services/aiService');
  const cfg = require('../config').ai;
  const title = req.body?.title || '测试标题';
  const content = req.body?.content || '这是一段用于自检的正常技术内容：今天写了一段 React 组件并解决了一个 hooks 闭包问题。';
  const t0 = Date.now();
  try {
    const result = await ai.auditContent({ title, content });
    return ok(res, {
      provider: cfg.provider,
      model: cfg.model,
      apiKeyConfigured: !!cfg.apiKey,
      elapsedMs: Date.now() - t0,
      result,
    });
  } catch (e) {
    return fail(res, `AI 调用失败：${e.message}`, 500, 500);
  }
}

module.exports = {
  stats,
  aiStats,
  listUsers,
  updateUserRole,
  listWords,
  addWord,
  deleteWord,
  listAudits,
  listSettings,
  updateSetting,
  testAi,
};
