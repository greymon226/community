'use strict';

// CAS 单点登录服务抽象。
// 默认提供 Mock 实现：本地账号密码登录 + 自动同步用户信息。
// 接入真实 CAS 时只需实现 verifyTicket 与 buildLoginUrl 即可。

const bcrypt = require('bcryptjs');
const config = require('../config');
const { User } = require('../models');

function buildLoginUrl(serviceUrl) {
  if (config.cas.mock) {
    // Mock 模式直接重定向到前端登录页
    return `${serviceUrl}?mock=1`;
  }
  const url = new URL('/login', config.cas.serverUrl);
  url.searchParams.set('service', serviceUrl);
  return url.toString();
}

/**
 * 真实 CAS：使用 ticket 调用 /serviceValidate 解析用户信息。
 * 此处仅给出接口契约，企业可按需实现具体 XML/JSON 解析。
 */
async function verifyTicket(/* ticket */) {
  if (config.cas.mock) {
    throw new Error('Mock CAS does not support ticket verification, use /auth/login instead.');
  }
  // TODO: 调用 CAS_SERVER_URL/serviceValidate 解析返回，构造 profile
  // const resp = await fetch(...);
  // return { empNo, name, email, department, avatar };
  throw new Error('CAS verifyTicket not implemented. Please integrate with your CAS server.');
}

/**
 * 同步/创建用户记录：CAS 验证通过或 Mock 登录成功后调用
 */
async function syncUserFromProfile(profile) {
  let user = await User.findOne({ where: { empNo: profile.empNo } });
  if (!user) {
    user = await User.create({
      empNo: profile.empNo,
      name: profile.name,
      email: profile.email,
      department: profile.department,
      avatar: profile.avatar || '',
      nickname: profile.nickname || profile.name,
    });
  } else {
    // 同步基本信息
    await user.update({
      name: profile.name || user.name,
      email: profile.email || user.email,
      department: profile.department || user.department,
      avatar: profile.avatar || user.avatar,
      lastLoginAt: new Date(),
    });
  }
  return user;
}

/**
 * Mock 模式的密码校验
 */
async function verifyLocalPassword(empNo, password) {
  const user = await User.findOne({ where: { empNo } });
  if (!user || user.status !== 'active') return null;
  if (!user.passwordHash) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}

module.exports = {
  buildLoginUrl,
  verifyTicket,
  syncUserFromProfile,
  verifyLocalPassword,
};
