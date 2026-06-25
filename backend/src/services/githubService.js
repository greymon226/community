'use strict';

const https = require('https');
const config = require('../config');
const { User } = require('../models');

/**
 * 构建 GitHub OAuth 授权 URL
 * @param {string} state - CSRF 防护随机串（由调用方生成并存 session/cookie）
 */
function buildOAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: config.github.callbackUrl,
    scope: 'read:user user:email',
    state: state || '',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * 用 code 换取 GitHub access_token
 */
async function exchangeCode(code) {
  const body = JSON.stringify({
    client_id: config.github.clientId,
    client_secret: config.github.clientSecret,
    code,
    redirect_uri: config.github.callbackUrl,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'github.com',
        path: '/login/oauth/access_token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000, // 15秒超时
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          console.log('[GitHub OAuth] token response status:', res.statusCode);
          try {
            const json = JSON.parse(data);
            if (json.error) {
              return reject(new Error(`GitHub OAuth error: ${json.error_description || json.error}`));
            }
            if (!json.access_token) {
              return reject(new Error(`GitHub 未返回 access_token，原始响应: ${data}`));
            }
            resolve(json.access_token);
          } catch (e) {
            reject(new Error(`GitHub token 响应解析失败: ${data}`));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('GitHub 访问超时，请稍后重试'));
    });
    req.on('error', (err) => {
      console.error('[GitHub OAuth] exchangeCode network error:', err);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

/**
 * 用 access_token 获取 GitHub 用户信息
 */
async function getGithubUser(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: '/user',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'community-app',
          Accept: 'application/vnd.github+json',
        },
        timeout: 15000, // 15秒超时
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          console.log('[GitHub OAuth] user response status:', res.statusCode);
          try {
            const json = JSON.parse(data);
            if (res.statusCode !== 200) {
              return reject(new Error(`GitHub 获取用户失败 (${res.statusCode}): ${json.message || data}`));
            }
            resolve(json);
          } catch (e) {
            reject(new Error(`GitHub 用户信息解析失败: ${data}`));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('GitHub 获取用户信息超时，请稍后重试'));
    });
    req.on('error', (err) => {
      console.error('[GitHub OAuth] getGithubUser network error:', err);
      reject(err);
    });
    req.end();
  });
}

/**
 * 根据 GitHub profile upsert User 记录
 * - 优先匹配 githubId
 * - 新用户使用 github:<id> 作为 empNo 占位
 */
async function syncUserFromGithub(profile) {
  const githubId = String(profile.id);
  const githubUsername = profile.login;
  const name = profile.name || githubUsername;
  const email = profile.email || null;
  const avatar = profile.avatar_url || null;

  // 先查是否已存在
  let user = await User.findOne({ where: { githubId } });

  if (user) {
    // 更新基础信息
    user.githubUsername = githubUsername;
    if (avatar) user.avatar = avatar;
    if (email && !user.email) user.email = email;
    user.lastLoginAt = new Date();
    await user.save();
    return user;
  }

  // 新建用户
  user = await User.create({
    empNo: `github:${githubId}`,   // 唯一占位，不与 CAS 用户冲突
    name,
    nickname: githubUsername,
    email,
    avatar,
    githubId,
    githubUsername,
    lastLoginAt: new Date(),
    status: 'active',
  });

  return user;
}

module.exports = { buildOAuthUrl, exchangeCode, getGithubUser, syncUserFromGithub };
