'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { User } = require('../models');
const { fail } = require('../utils/response');

function signToken(user) {
  return jwt.sign(
    { id: user.id, empNo: user.empNo, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

async function authRequired(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return fail(res, '未登录', 401, 401);
    const payload = jwt.verify(token, config.jwt.secret);
    const user = await User.findByPk(payload.id);
    if (!user || user.status !== 'active') return fail(res, '用户不可用', 401, 401);
    req.user = user;
    next();
  } catch (err) {
    return fail(res, '登录态无效', 401, 401);
  }
}

// 可选鉴权：有 token 则解析，无 token 也不阻塞
async function authOptional(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next();
    const payload = jwt.verify(token, config.jwt.secret);
    const user = await User.findByPk(payload.id);
    if (user && user.status === 'active') req.user = user;
  } catch (e) {
    // 忽略
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return fail(res, '未登录', 401, 401);
    if (!roles.includes(req.user.role)) return fail(res, '权限不足', 403, 403);
    next();
  };
}

// 版主或管理员：检查是否有权管理目标板块
function canModerateCategory(user, categoryId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'moderator') {
    try {
      const ids = JSON.parse(user.moderatorCategoryIds || '[]');
      return ids.includes(categoryId);
    } catch {
      return false;
    }
  }
  return false;
}

module.exports = { signToken, authRequired, authOptional, requireRole, canModerateCategory };
