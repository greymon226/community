'use strict';

const { Op } = require('sequelize');
const { User, Post, Comment, Favorite } = require('../models');
const { ok, fail } = require('../utils/response');
const { cleanPlainText } = require('../utils/sanitize');

// Pure helper extracted from `updateMe` so it can be exercised by
// `tests/property/P07-techtags-normalization.test.js` without booting
// Express / DB. Runtime behaviour is kept identical to the inline code in
// `updateMe` (see Property 7 in design.md and Requirements 3.3 / 3.5).
//
// Input is normalised to a comma-separated string first (matching the
// production path: `String(techTags).split(',')` accepts both arrays and
// strings) and the array of normalised tags is returned. Caller is
// responsible for `arr.join(',')` if a string form is desired.
function normalizeTechTags(input) {
  const arr = String(input)
    .split(',')
    .map((t) => cleanPlainText(t).slice(0, 32))
    .filter(Boolean);
  // 去重（按首次出现顺序保留）— Requirements 3.3, Property 7
  const seen = new Set();
  const deduped = [];
  for (const tag of arr) {
    if (!seen.has(tag)) {
      seen.add(tag);
      deduped.push(tag);
    }
  }
  return deduped.slice(0, 20);
}

// GET /users/:id
async function getProfile(req, res) {
  const user = await User.findByPk(req.params.id);
  if (!user) return fail(res, '用户不存在', 404, 404);

  const [postCount, favoriteCount] = await Promise.all([
    Post.count({ where: { authorId: user.id, status: 'published' } }),
    Favorite.count({ where: { userId: user.id } }),
  ]);

  // 用户被点赞次数：聚合其帖子的 likeCount
  const posts = await Post.findAll({
    where: { authorId: user.id, status: 'published' },
    attributes: ['likeCount'],
  });
  const totalLikes = posts.reduce((s, p) => s + p.likeCount, 0);

  return ok(res, {
    id: user.id,
    empNo: user.empNo,
    name: user.name,
    nickname: user.nickname,
    department: user.department,
    avatar: user.avatar,
    bio: user.bio,
    techTags: user.techTags,
    role: user.role,
    stats: {
      postCount,
      likeReceived: totalLikes,
      favoriteCount,
    },
  });
}

// PUT /users/me
async function updateMe(req, res) {
  const u = req.user;
  const { nickname, bio, techTags, avatar, emailNotify } = req.body || {};
  if (nickname !== undefined) u.nickname = cleanPlainText(nickname).slice(0, 64);
  if (bio !== undefined) u.bio = cleanPlainText(bio).slice(0, 500);
  if (techTags !== undefined) {
    const tags = normalizeTechTags(techTags);
    u.techTags = tags.join(',');
  }
  if (avatar !== undefined) u.avatar = String(avatar).slice(0, 255);
  if (emailNotify !== undefined) u.emailNotify = !!emailNotify;
  await u.save();
  return ok(res, u);
}

// GET /users/me/posts
async function myPosts(req, res) {
  const { status = 'published', page = 1, pageSize = 10 } = req.query;
  const where = { authorId: req.user.id };
  if (status !== 'all') where.status = status;
  const offset = (page - 1) * pageSize;
  const { rows, count } = await Post.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    offset,
    limit: +pageSize,
  });
  return ok(res, { items: rows, total: count, page: +page, pageSize: +pageSize });
}

// GET /users/me/favorites
async function myFavorites(req, res) {
  const favs = await Favorite.findAll({
    where: { userId: req.user.id },
    order: [['createdAt', 'DESC']],
    include: [{ association: 'post', include: [{ association: 'author', attributes: ['id', 'nickname', 'name', 'avatar'] }] }],
  });
  return ok(res, favs.map((f) => f.post).filter(Boolean));
}

// GET /users/me/comments
async function myComments(req, res) {
  const list = await Comment.findAll({
    where: { authorId: req.user.id, status: { [Op.ne]: 'deleted' } },
    order: [['createdAt', 'DESC']],
    include: [{ association: 'post', attributes: ['id', 'title'] }],
    limit: 100,
  });
  return ok(res, list);
}

module.exports = { getProfile, updateMe, myPosts, myFavorites, myComments };

// Test-only export: pure helper used by tests/property/P07-* to assert the
// techTags normalization invariant without requiring an HTTP / DB stack.
// Not part of the public controller API; do NOT import this from production
// code.
module.exports.__test = { normalizeTechTags };
