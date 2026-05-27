'use strict';

const { Report, Post, Comment } = require('../models');
const { ok, fail } = require('../utils/response');
const { writeAudit } = require('../middlewares/audit');

// POST /reports  body: { targetType, targetId, reason }
async function create(req, res) {
  const { targetType, targetId, reason } = req.body || {};
  if (!['post', 'comment'].includes(targetType) || !targetId || !reason) {
    return fail(res, '参数不完整', 400);
  }
  const r = await Report.create({
    reporterId: req.user.id,
    targetType,
    targetId,
    reason: String(reason).slice(0, 255),
  });
  await writeAudit(req, { action: 'report.create', targetType, targetId, detail: { reason } });
  return ok(res, r);
}

// GET /admin/reports
async function list(req, res) {
  const { status = 'pending', page = 1, pageSize = 20 } = req.query;
  const where = {};
  if (status !== 'all') where.status = status;
  const offset = (page - 1) * pageSize;
  const { rows, count } = await Report.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    offset,
    limit: +pageSize,
  });
  return ok(res, { items: rows, total: count });
}

// POST /admin/reports/:id/handle  body: { action: 'block'|'reject', remark }
async function handle(req, res) {
  const r = await Report.findByPk(req.params.id);
  if (!r) return fail(res, '举报不存在', 404, 404);
  const { action, remark = '' } = req.body || {};
  if (!['block', 'reject'].includes(action)) return fail(res, '动作非法');
  if (action === 'block') {
    if (r.targetType === 'post') {
      const p = await Post.findByPk(r.targetId);
      if (p) { p.status = 'blocked'; await p.save(); }
    } else {
      const c = await Comment.findByPk(r.targetId);
      if (c) { c.status = 'blocked'; await c.save(); }
    }
  }
  r.status = action === 'block' ? 'resolved' : 'rejected';
  r.handledBy = req.user.id;
  r.handledAt = new Date();
  r.remark = remark;
  await r.save();
  await writeAudit(req, { action: `report.${action}`, targetType: r.targetType, targetId: r.targetId, detail: { remark } });
  return ok(res, r);
}

module.exports = { create, list, handle };
