'use strict';

const { Op } = require('sequelize');
const { Post, User, Category, Tag, PostTag, Comment, Like, Favorite } = require('../models');
const { ok, fail } = require('../utils/response');
const { cleanRichText, cleanPlainText, buildSummary } = require('../utils/sanitize');
const moderation = require('../services/moderationService');
const ai = require('../services/aiService');
const settings = require('../services/settingService');
const cache = require('../services/cacheService');
const search = require('../services/searchService');
const notify = require('../services/notificationService');
const { writeAudit } = require('../middlewares/audit');
const { canModerateCategory } = require('../middlewares/auth');

// GET /posts  列表 / 搜索
async function list(req, res) {
  const {
    keyword, categoryId, authorId, tag,
    sort = 'latest', page = 1, pageSize = 10,
  } = req.query;
  const data = await search.searchPosts({
    keyword,
    categoryId: categoryId ? +categoryId : undefined,
    authorId: authorId ? +authorId : undefined,
    tag,
    sort,
    page: +page,
    pageSize: Math.min(50, +pageSize),
  });
  return ok(res, data);
}

// GET /posts/:id
async function detail(req, res) {
  const post = await Post.findByPk(req.params.id, {
    include: [
      { model: User, as: 'author', attributes: ['id', 'name', 'nickname', 'avatar', 'department'] },
      { model: Category, as: 'category' },
      { model: Tag, as: 'tags', through: { attributes: [] } },
    ],
  });
  if (!post || post.status === 'deleted') return fail(res, '帖子不存在', 404, 404);
  if (post.status === 'blocked' && (!req.user || (req.user.role !== 'admin' && req.user.id !== post.authorId))) {
    return fail(res, '帖子已被屏蔽', 403, 403);
  }
  // 增加浏览量（异步，避免阻塞响应）
  post.increment('viewCount').catch(() => {});

  let liked = false;
  let favorited = false;
  if (req.user) {
    [liked, favorited] = await Promise.all([
      Like.findOne({ where: { userId: req.user.id, targetType: 'post', targetId: post.id } }).then(Boolean),
      Favorite.findOne({ where: { userId: req.user.id, postId: post.id } }).then(Boolean),
    ]);
  }
  return ok(res, { ...post.toJSON(), liked, favorited });
}

// POST /posts
async function create(req, res) {
  const { title, content, categoryId, tags = [], status = 'published' } = req.body || {};
  if (!title || !content || !categoryId) return fail(res, '标题、正文、分类必填');

  const cleanTitle = cleanPlainText(title).slice(0, 200);
  const cleanContent = cleanRichText(content);

  // 敏感词过滤
  const titleFilter = await moderation.applySensitiveFilter(cleanTitle);
  const contentFilter = await moderation.applySensitiveFilter(cleanPlainText(cleanContent));
  if (titleFilter.blocked || contentFilter.blocked) {
    return fail(res, '内容包含禁止发布的敏感词', 4001, 400);
  }

  const isDraft = status === 'draft';

  // AI 审核（可由管理员通过系统设置关闭；草稿不走 AI）
  const aiEnabled = await settings.get('aiAuditEnabled');
  const audit = aiEnabled && !isDraft
    ? await ai.auditContent({ title: cleanTitle, content: cleanContent })
    : { status: 'pass', reason: '' };

  // blocked：直接拒绝创建，前端按失败处理
  if (audit.status === 'blocked') {
    await writeAudit(req, {
      action: 'post.rejected_by_ai',
      targetType: 'post',
      detail: { title: cleanTitle, reason: audit.reason },
    });
    return fail(
      res,
      `AI 审核未通过：${audit.reason || '内容违反社区规范'}`,
      4002,
      400
    );
  }

  // review：创建但隐藏（status=blocked），等待版主/管理员处理
  // pass / draft：正常状态
  let finalStatus;
  if (isDraft) finalStatus = 'draft';
  else if (audit.status === 'review') finalStatus = 'blocked';
  else finalStatus = 'published';

  const post = await Post.create({
    title: titleFilter.cleanText,
    content: cleanContent,
    summary: buildSummary(cleanContent),
    authorId: req.user.id,
    categoryId,
    status: finalStatus,
    aiAuditStatus: !aiEnabled ? 'skipped' : audit.status,
    aiAuditReason: !aiEnabled ? 'AI 审核已关闭' : audit.reason,
  });

  // 关联标签
  await attachTags(post, tags);

  await writeAudit(req, { action: 'post.create', targetType: 'post', targetId: post.id, detail: { title } });

  // pending 标记便于前端区分提示
  return ok(
    res,
    { ...post.toJSON(), pending: audit.status === 'review' },
    audit.status === 'review'
      ? '已提交，AI 审核存疑，等待管理员复审'
      : isDraft
      ? '已保存为草稿'
      : '发布成功'
  );
}

// PUT /posts/:id
async function update(req, res) {
  const post = await Post.findByPk(req.params.id);
  if (!post || post.status === 'deleted') return fail(res, '帖子不存在', 404, 404);
  if (post.authorId !== req.user.id && req.user.role !== 'admin') {
    return fail(res, '无权修改', 403, 403);
  }
  const { title, content, categoryId, tags, status } = req.body || {};
  const contentChanged = content || title;

  if (title) post.title = cleanPlainText(title).slice(0, 200);
  if (content) {
    post.content = cleanRichText(content);
    post.summary = buildSummary(post.content);
  }
  if (categoryId) post.categoryId = categoryId;

  // 状态切换 + 内容变更后重新走审核（草稿不走）
  const targetStatus = status && ['draft', 'published'].includes(status) ? status : post.status;
  const isDraft = targetStatus === 'draft';

  if (contentChanged && !isDraft) {
    const aiEnabled = await settings.get('aiAuditEnabled');
    const audit = aiEnabled
      ? await ai.auditContent({ title: post.title, content: post.content })
      : { status: 'pass', reason: '' };

    if (audit.status === 'blocked') {
      await writeAudit(req, {
        action: 'post.rejected_by_ai',
        targetType: 'post',
        targetId: post.id,
        detail: { reason: audit.reason },
      });
      return fail(res, `AI 审核未通过：${audit.reason || '内容违反社区规范'}`, 4002, 400);
    }

    post.aiAuditStatus = !aiEnabled ? 'skipped' : audit.status;
    post.aiAuditReason = !aiEnabled ? 'AI 审核已关闭' : audit.reason;
    post.status = audit.status === 'review' ? 'blocked' : 'published';
  } else if (isDraft) {
    post.status = 'draft';
  }

  await post.save();
  if (Array.isArray(tags)) await attachTags(post, tags);
  await writeAudit(req, { action: 'post.update', targetType: 'post', targetId: post.id });

  const pending = post.aiAuditStatus === 'review' && !isDraft;
  return ok(
    res,
    { ...post.toJSON(), pending },
    pending ? '已更新，AI 审核存疑，等待管理员复审' : '已更新'
  );
}

// DELETE /posts/:id
async function remove(req, res) {
  const post = await Post.findByPk(req.params.id);
  if (!post) return fail(res, '帖子不存在', 404, 404);
  if (post.authorId !== req.user.id && req.user.role !== 'admin') {
    return fail(res, '无权删除', 403, 403);
  }
  post.status = 'deleted';
  await post.save();
  await writeAudit(req, { action: 'post.delete', targetType: 'post', targetId: post.id });
  return ok(res, null, '已删除');
}

// POST /posts/:id/like
async function toggleLike(req, res) {
  const post = await Post.findByPk(req.params.id);
  if (!post) return fail(res, '帖子不存在', 404, 404);
  const exist = await Like.findOne({
    where: { userId: req.user.id, targetType: 'post', targetId: post.id },
  });
  if (exist) {
    await exist.destroy();
    await post.decrement('likeCount');
    await post.reload();
    return ok(res, { liked: false, likeCount: post.likeCount });
  }
  try {
    await Like.create({ userId: req.user.id, targetType: 'post', targetId: post.id });
  } catch (e) {
    if (e.name === 'SequelizeUniqueConstraintError') {
      await post.reload();
      return ok(res, { liked: true, likeCount: post.likeCount });
    }
    throw e;
  }
  await post.increment('likeCount');
  await post.reload();
  await notify.notify({
    userId: post.authorId,
    fromUserId: req.user.id,
    type: 'liked',
    title: `${req.user.nickname || req.user.name} 点赞了你的帖子`,
    content: post.title,
    payload: { postId: post.id },
  });
  return ok(res, { liked: true, likeCount: post.likeCount });
}

// POST /posts/:id/favorite
async function toggleFavorite(req, res) {
  const post = await Post.findByPk(req.params.id);
  if (!post) return fail(res, '帖子不存在', 404, 404);
  const exist = await Favorite.findOne({ where: { userId: req.user.id, postId: post.id } });
  if (exist) {
    await exist.destroy();
    await post.decrement('favoriteCount');
    await post.reload();
    return ok(res, { favorited: false, favoriteCount: post.favoriteCount });
  }
  try {
    await Favorite.create({ userId: req.user.id, postId: post.id });
  } catch (e) {
    if (e.name === 'SequelizeUniqueConstraintError') {
      await post.reload();
      return ok(res, { favorited: true, favoriteCount: post.favoriteCount });
    }
    throw e;
  }
  await post.increment('favoriteCount');
  await post.reload();
  return ok(res, { favorited: true, favoriteCount: post.favoriteCount });
}

// POST /admin/posts/:id/pin     body: { level: 0|1|2 }
async function pin(req, res) {
  const post = await Post.findByPk(req.params.id);
  if (!post) return fail(res, '帖子不存在', 404, 404);
  if (!canModerateCategory(req.user, post.categoryId)) return fail(res, '无权操作', 403, 403);
  post.pinned = Math.max(0, Math.min(2, +req.body.level || 0));
  await post.save();
  await writeAudit(req, { action: 'post.pin', targetType: 'post', targetId: post.id, detail: { level: post.pinned } });
  if (post.pinned > 0) {
    await notify.notify({
      userId: post.authorId,
      fromUserId: req.user.id,
      type: 'pinned',
      title: '你的帖子被置顶',
      content: post.title,
      payload: { postId: post.id, level: post.pinned },
    });
  }
  return ok(res, post);
}

// POST /admin/posts/:id/feature
async function feature(req, res) {
  const post = await Post.findByPk(req.params.id);
  if (!post) return fail(res, '帖子不存在', 404, 404);
  if (!canModerateCategory(req.user, post.categoryId)) return fail(res, '无权操作', 403, 403);
  post.featured = !post.featured;
  await post.save();
  await writeAudit(req, { action: 'post.feature', targetType: 'post', targetId: post.id, detail: { featured: post.featured } });
  if (post.featured) {
    await notify.notify({
      userId: post.authorId,
      fromUserId: req.user.id,
      type: 'featured',
      title: '你的帖子被加精',
      content: post.title,
      payload: { postId: post.id },
    });
  }
  return ok(res, post);
}

// POST /admin/posts/:id/block
async function block(req, res) {
  const post = await Post.findByPk(req.params.id);
  if (!post) return fail(res, '帖子不存在', 404, 404);
  if (!canModerateCategory(req.user, post.categoryId)) return fail(res, '无权操作', 403, 403);
  post.status = post.status === 'blocked' ? 'published' : 'blocked';
  await post.save();
  await writeAudit(req, { action: 'post.block', targetType: 'post', targetId: post.id, detail: { status: post.status } });
  return ok(res, post);
}

// GET /posts/recommend  AI 推荐
async function recommend(req, res) {
  const list = await ai.recommendPosts(req.user, 10);
  return ok(res, list);
}

// GET /posts/:id/explain  AI 解读
//   - 受 aiExplainEnabled 开关控制
//   - 同一帖子的解读结果在 24h 内缓存复用，且帖子内容更新时失效（按 updatedAt 拼 cache key）
//   - 受 aiExplainPerUserDailyLimit 配额限制，避免被刷
async function explain(req, res) {
  const enabled = await settings.get('aiExplainEnabled');
  if (!enabled) return fail(res, 'AI 解读功能已关闭', 4003, 403);

  const post = await Post.findByPk(req.params.id);
  if (!post || post.status === 'deleted') return fail(res, '帖子不存在', 404, 404);
  if (post.status === 'blocked' && (req.user?.role !== 'admin' && req.user?.id !== post.authorId)) {
    return fail(res, '帖子不可访问', 403, 403);
  }

  // 缓存：同一帖子+同一更新时间共享解读
  const cacheKey = `ai:explain:post:${post.id}:${new Date(post.updatedAt).getTime()}`;
  const cached = await cache.get(cacheKey);
  if (cached) {
    return ok(res, { ...cached, cached: true });
  }

  // 配额：单用户每天 N 次
  const limit = await settings.get('aiExplainPerUserDailyLimit');
  const today = new Date().toISOString().slice(0, 10);
  const quotaKey = `ai:explain:quota:${req.user.id}:${today}`;
  const used = (await cache.get(quotaKey)) || 0;
  if (limit > 0 && used >= limit) {
    return fail(res, `今日 AI 解读次数已用完（上限 ${limit} 次），请明天再试`, 4004, 429);
  }

  let result;
  try {
    result = await ai.explainPost({ title: post.title, content: post.content });
  } catch (e) {
    return fail(res, `AI 解读失败：${e.message}`, 5001, 502);
  }

  // 写缓存（24h）+ 计数
  await cache.set(cacheKey, result, 24 * 3600);
  await cache.set(quotaKey, used + 1, 24 * 3600);

  return ok(res, { ...result, cached: false, quotaUsed: used + 1, quotaLimit: limit });
}

// 辅助：标签输入归一化（纯函数）
//   - 接受任意输入：非数组 → 视为空
//   - 元素经 cleanPlainText、截断 32 字、过滤空串
//   - 按首次出现顺序去重
//   - 截断为最多 10 项
function normalizeTags(tagNames) {
  const arr = Array.isArray(tagNames) ? tagNames : [];
  const cleaned = arr
    .map((t) => cleanPlainText(String(t)).slice(0, 32).trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const n of cleaned) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.slice(0, 10);
}

// 辅助：把标签数组绑定到帖子
async function attachTags(post, tagNames) {
  const cleanedNames = normalizeTags(tagNames);
  if (cleanedNames.length === 0) {
    await PostTag.destroy({ where: { postId: post.id } });
    return;
  }
  const existing = await Tag.findAll({ where: { name: { [Op.in]: cleanedNames } } });
  const existingNames = new Set(existing.map((t) => t.name));
  const toCreate = cleanedNames.filter((n) => !existingNames.has(n));
  const created = await Promise.all(toCreate.map((name) => Tag.create({ name })));
  const all = [...existing, ...created];
  await PostTag.destroy({ where: { postId: post.id } });
  await PostTag.bulkCreate(all.map((t) => ({ postId: post.id, tagId: t.id })));
  await Promise.all(all.map((t) => t.increment('usageCount')));
}

module.exports = {
  list, detail, create, update, remove,
  toggleLike, toggleFavorite,
  pin, feature, block,
  recommend, explain,
};

// Internal helpers exposed for property tests only. NOT part of the public API.
module.exports.__test = { normalizeTags, attachTags };
