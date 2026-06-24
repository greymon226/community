'use strict';

// CAS 单点登录服务抽象。
// 默认提供 Mock 实现：本地账号密码登录 + 自动同步用户信息。
// 真实 CAS 模式使用 /serviceValidate 校验 ticket 并同步用户信息。

const bcrypt = require('bcryptjs');
const config = require('../config');
const { User } = require('../models');

function buildLoginUrl(serviceUrl) {
  if (config.cas.mock) {
    // Mock 模式直接重定向到前端登录页
    return `${serviceUrl}?mock=1`;
  }
  const url = buildCasUrl('login');
  url.searchParams.set('service', serviceUrl);
  return url.toString();
}

/**
 * 真实 CAS：使用 ticket 调用 /serviceValidate 解析用户信息。
 */
async function verifyTicket(ticket, serviceUrl) {
  if (config.cas.mock) {
    throw new Error('Mock CAS does not support ticket verification, use /auth/login instead.');
  }
  if (!ticket) throw new Error('CAS ticket is required.');
  const service = serviceUrl || config.cas.serviceUrl;
  if (!service) throw new Error('CAS_SERVICE_URL is required.');

  const url = buildCasUrl('serviceValidate');
  url.searchParams.set('service', service);
  url.searchParams.set('ticket', ticket);

  const resp = await fetch(url, { headers: { Accept: 'application/xml,text/xml,*/*' } });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(`CAS serviceValidate failed: HTTP ${resp.status}`);
  }
  return parseServiceValidateXml(body);
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

function buildCasUrl(pathname) {
  if (!config.cas.serverUrl) throw new Error('CAS_SERVER_URL is required.');
  const base = config.cas.serverUrl.endsWith('/') ? config.cas.serverUrl : `${config.cas.serverUrl}/`;
  return new URL(pathname.replace(/^\/+/, ''), base);
}

function parseServiceValidateXml(xml) {
  if (!hasTag(xml, 'authenticationSuccess')) {
    const message = readTag(xml, 'authenticationFailure') || 'CAS authentication failed.';
    throw new Error(message);
  }

  const casUser = readTag(xml, 'user');
  const attributesXml = readTagXml(xml, 'attributes') || '';
  const attrs = parseAttributes(attributesXml);
  const empNo = pickAttr(attrs, config.cas.attrs.empNo) || casUser;
  const name = pickAttr(attrs, config.cas.attrs.name) || empNo;

  if (!empNo) throw new Error('CAS response missing user identifier.');

  return {
    empNo,
    name,
    nickname: pickAttr(attrs, 'nickname,nickName,displayName') || name,
    email: pickAttr(attrs, config.cas.attrs.email) || '',
    department: pickAttr(attrs, config.cas.attrs.department) || '',
    avatar: pickAttr(attrs, config.cas.attrs.avatar) || '',
  };
}

function parseAttributes(xml) {
  const attrs = {};
  const re = /<(?:(?:\w+):)?([\w.-]+)(?:\s[^>]*)?>([\s\S]*?)<\/(?:(?:\w+):)?\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const key = m[1];
    if (key === 'attributes') continue;
    attrs[key] = decodeXml(m[2].replace(/<[^>]+>/g, '').trim());
  }
  return attrs;
}

function pickAttr(attrs, names) {
  for (const name of String(names || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (attrs[name]) return attrs[name];
  }
  return '';
}

function hasTag(xml, tag) {
  return new RegExp(`<(?:(?:\\w+):)?${tag}(?:\\s[^>]*)?>`, 'i').test(xml);
}

function readTag(xml, tag) {
  const raw = readTagXml(xml, tag);
  return raw ? decodeXml(raw.replace(/<[^>]+>/g, '').trim()) : '';
}

function readTagXml(xml, tag) {
  const m = new RegExp(`<(?:(?:\\w+):)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${tag}>`, 'i').exec(xml);
  return m ? m[1] : '';
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

module.exports = {
  buildLoginUrl,
  verifyTicket,
  syncUserFromProfile,
  verifyLocalPassword,
  __test: { parseServiceValidateXml, buildCasUrl },
};
