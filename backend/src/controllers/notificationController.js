'use strict';

const { Op } = require('sequelize');
const { Notification, User } = require('../models');
const { ok } = require('../utils/response');

// GET /notifications
async function list(req, res) {
  const { unreadOnly, page = 1, pageSize = 20 } = req.query;
  const where = { userId: req.user.id };
  if (unreadOnly === '1' || unreadOnly === 'true') where.read = false;
  const offset = (page - 1) * pageSize;
  const { rows, count } = await Notification.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    offset,
    limit: +pageSize,
    include: [{ model: User, as: 'fromUser', attributes: ['id', 'nickname', 'name', 'avatar'] }],
  });
  const unreadCount = await Notification.count({ where: { userId: req.user.id, read: false } });
  return ok(res, { items: rows, total: count, unreadCount, page: +page, pageSize: +pageSize });
}

// POST /notifications/read
async function markRead(req, res) {
  const { ids } = req.body || {};
  const where = { userId: req.user.id };
  if (Array.isArray(ids) && ids.length) where.id = { [Op.in]: ids };
  await Notification.update({ read: true }, { where });
  return ok(res, null, '已标记');
}

module.exports = { list, markRead };
