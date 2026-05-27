'use strict';

const config = require('../config');
const { ok, fail } = require('../utils/response');
const cas = require('../services/casService');
const { signToken } = require('../middlewares/auth');

// GET /auth/cas/login-url
async function loginUrl(req, res) {
  const service = req.query.service || (config.cas.serviceUrl || '');
  return ok(res, {
    mock: config.cas.mock,
    url: cas.buildLoginUrl(service),
  });
}

// POST /auth/login  Mock 模式：本地账号密码登录
async function localLogin(req, res) {
  const { empNo, password } = req.body || {};
  if (!empNo || !password) return fail(res, '工号与密码不能为空');
  const user = await cas.verifyLocalPassword(empNo, password);
  if (!user) return fail(res, '工号或密码错误', 401, 401);
  user.lastLoginAt = new Date();
  await user.save();
  const token = signToken(user);
  return ok(res, { token, user: shapeUser(user) });
}

// GET /auth/cas/callback?ticket=xxx  真实 CAS 回调
async function casCallback(req, res) {
  const ticket = req.query.ticket;
  if (!ticket) return fail(res, '缺少 ticket', 400);
  try {
    const profile = await cas.verifyTicket(ticket);
    const user = await cas.syncUserFromProfile(profile);
    const token = signToken(user);
    return ok(res, { token, user: shapeUser(user) });
  } catch (e) {
    return fail(res, e.message, 500, 500);
  }
}

// GET /auth/me
async function me(req, res) {
  return ok(res, shapeUser(req.user));
}

// POST /auth/logout
async function logout(_req, res) {
  // JWT 无状态，前端清除 token 即可。如需服务端注销可结合 Redis 黑名单。
  return ok(res, null, '已退出登录');
}

function shapeUser(user) {
  return {
    id: user.id,
    empNo: user.empNo,
    name: user.name,
    nickname: user.nickname,
    email: user.email,
    department: user.department,
    avatar: user.avatar,
    bio: user.bio,
    techTags: user.techTags,
    role: user.role,
    emailNotify: user.emailNotify,
  };
}

module.exports = { loginUrl, localLogin, casCallback, me, logout };
