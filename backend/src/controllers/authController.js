'use strict';

const config = require('../config');
const { ok, fail } = require('../utils/response');
const cas = require('../services/casService');
const github = require('../services/githubService');
const { signToken } = require('../middlewares/auth');
const { writeAudit } = require('../middlewares/audit');

// GET /auth/cas/login-url
async function loginUrl(req, res) {
  const service = req.query.service || (config.cas.serviceUrl || '');
  if (!config.cas.mock && !service) return fail(res, 'CAS_SERVICE_URL 未配置', 500, 500);
  return ok(res, {
    mock: config.cas.mock,
    url: cas.buildLoginUrl(service),
  });
}

// POST /auth/login  Mock 模式：本地账号密码登录
async function localLogin(req, res) {
  if (!config.cas.mock) return fail(res, '当前已启用 CAS 登录', 403, 403);
  const { empNo, password } = req.body || {};
  if (!empNo || !password) return fail(res, '工号与密码不能为空');
  const user = await cas.verifyLocalPassword(empNo, password);
  if (!user) return fail(res, '工号或密码错误', 401, 401);
  user.lastLoginAt = new Date();
  await user.save();
  const token = signToken(user);
  
  req.user = user;
  await writeAudit(req, { action: 'user.login', targetType: 'user', targetId: user.id, detail: { method: 'local', empNo: user.empNo } });

  return ok(res, { token, user: shapeUser(user) });
}

// GET /auth/cas/callback?ticket=xxx  真实 CAS 回调
async function casCallback(req, res) {
  const ticket = req.query.ticket;
  if (!ticket) return fail(res, '缺少 ticket', 400);
  try {
    const profile = await cas.verifyTicket(ticket, req.query.service);
    const user = await cas.syncUserFromProfile(profile);
    if (user.status !== 'active') return fail(res, '账号已禁用', 401, 401);
    const token = signToken(user);

    req.user = user;
    await writeAudit(req, { action: 'user.login', targetType: 'user', targetId: user.id, detail: { method: 'cas', empNo: user.empNo } });

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
async function logout(req, res) {
  if (req.user) {
    await writeAudit(req, { action: 'user.logout', targetType: 'user', targetId: req.user.id });
  }
  // JWT 无状态，前端清除 token 即可。如需服务端注销可结合 Redis 黑名单。
  return ok(res, null, '已退出登录');
}

// GET /auth/github/login-url?state=xxx
async function githubLoginUrl(req, res) {
  if (!config.github.clientId || !config.github.clientSecret) {
    return ok(res, { enabled: false, url: '' });
  }
  const { state } = req.query;
  if (!state) return fail(res, '缺少 state 参数', 400);
  return ok(res, { enabled: true, url: github.buildOAuthUrl(state) });
}

// GET /auth/github/callback?code=xxx
async function githubCallback(req, res) {
  const { code } = req.query;
  if (!code) return fail(res, '缺少 code 参数', 400);
  try {
    const accessToken = await github.exchangeCode(code);
    const profile = await github.getGithubUser(accessToken);
    const user = await github.syncUserFromGithub(profile);
    if (user.status !== 'active') return fail(res, '账号已禁用', 401, 401);
    const token = signToken(user);

    req.user = user;
    await writeAudit(req, { action: 'user.login', targetType: 'user', targetId: user.id, detail: { method: 'github', githubUsername: user.githubUsername } });

    return ok(res, { token, user: shapeUser(user) });
  } catch (e) {
    console.error('[GitHub OAuth] callback error:', e);
    return fail(res, e.message, 500, 500);
  }
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
    githubUsername: user.githubUsername || null,
  };
}

module.exports = { loginUrl, localLogin, casCallback, githubLoginUrl, githubCallback, me, logout };
