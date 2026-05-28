'use strict';

const { Op } = require('sequelize');
const { Comment, Post, User, Like } = require('../models');
const { ok, fail } = require('../utils/response');
const { cleanRichText, cleanPlainText } = require('../utils/sanitize');
const moderation = require('../services/moderationService');
const ai = require('../services/aiService');
const settings = require('../services/settingService');
const notify = require('../services/notificationService');
const { writeAudit } = require('../middlewares/audit');
const { canModerateCategory } = require('../middlewares/auth');

// GET /posts/:postId/comments
async function listByPost(req, res) {
  const list = await Comment.findAll({
    where: { postId: req.params.postId, status: 'active' },
    include: [
      { model: User, as: 'author', attributes: ['id', 'nickname', 'name', 'avatar'] },
      {
        model: Comment,
        as: 'replyTo',
        include: [{ model: User, as: 'author', attributes: ['id', 'nickname', 'name'] }],
      },
    ],
    order: [['createdAt', 'ASC']],
  });
  let likedSet = new Set();
  if (req.user) {
    const likes = await Like.findAll({
      where: { userId: req.user.id, targetType: 'comment', targetId: { [Op.in]: list.map((c) => c.id) } },
    });
    likedSet = new Set(likes.map((l) => l.targetId));
  }
  return ok(res, list.map((c) => ({ ...c.toJSON(), liked: likedSet.has(c.id) })));
}

// POST /posts/:postId/comments  body: { content, replyToId? }
async function create(req, res) {
  const { content, replyToId = null } = req.body || {};
  if (!content) return fail(res, '内容不能为空');
  const post = await Post.findByPk(req.params.postId);
  if (!post || post.status !== 'published') return fail(res, '帖子不可评论', 400);

  const html = cleanRichText(content);
  const filter = await moderation.applySensitiveFilter(cleanPlainText(html));
  if (filter.blocked) return fail(res, '内容包含禁止发布的敏感词', 4001, 400);

  // AI 审核（评论与帖子使用同一开关）
  const aiEnabled = await settings.get('aiAuditEnabled');
  if (aiEnabled) {
    const audit = await ai.auditContent({ title: '', content: cleanPlainText(html) });
    if (audit.status === 'blocked') {
      return fail(res, `AI 审核未通过：${audit.reason || '内容违反社区规范'}`, 4002, 400);
    }
    // review 状态下的评论标记为 blocked，不展示给其他人
    if (audit.status === 'review') {
      const comment = await Comment.create({
        postId: post.id, authorId: req.user.id, content: html, replyToId, status: 'blocked',
      });
      return ok(res, { ...comment.toJSON(), pending: true }, '已提交，AI 审核存疑，等待管理员复审');
    }
  }

  const comment = await Comment.create({
    postId: post.id,
    authorId: req.user.id,
    content: html,
    replyToId,
  });
  await post.increment('commentCount');

  // 通知帖子作者
  await notify.notify({
    userId: post.authorId,
    fromUserId: req.user.id,
    type: 'commented',
    title: `${req.user.nickname || req.user.name} 评论了你的帖子`,
    content: cleanPlainText(html).slice(0, 80),
    payload: { postId: post.id, commentId: comment.id },
  });
  // 通知被引用作者
  if (replyToId) {
    const target = await Comment.findByPk(replyToId);
    if (target) {
      await notify.notify({
        userId: target.authorId,
        fromUserId: req.user.id,
        type: 'replied',
        title: `${req.user.nickname || req.user.name} 回复了你`,
        content: cleanPlainText(html).slice(0, 80),
        payload: { postId: post.id, commentId: comment.id },
      });
    }
  }
  return ok(res, comment);
}

// DELETE /comments/:id
async function remove(req, res) {
  const c = await Comment.findByPk(req.params.id);
  if (!c) return fail(res, '评论不存在', 404, 404);
  const post = await Post.findByPk(c.postId);
  const isOwner = c.authorId === req.user.id;
  const isMod = post && canModerateCategory(req.user, post.categoryId);
  if (!isOwner && !isMod) return fail(res, '无权删除', 403, 403);
  const wasActive = c.status === 'active';
  c.status = 'deleted';
  await c.save();
  // 仅当评论原来是 active 时才减 commentCount（blocked 评论从未被计入）
  if (post && wasActive) await post.decrement('commentCount');
  await writeAudit(req, { action: 'comment.delete', targetType: 'comment', targetId: c.id });
  return ok(res, null, '已删除');
}

// POST /comments/:id/like
async function toggleLike(req, res) {
  const c = await Comment.findByPk(req.params.id);
  if (!c) return fail(res, '评论不存在', 404, 404);
  const exist = await Like.findOne({
    where: { userId: req.user.id, targetType: 'comment', targetId: c.id },
  });
  if (exist) {
    await exist.destroy();
    await c.decrement('likeCount');
    await c.reload();
    return ok(res, { liked: false, likeCount: c.likeCount });
  }
  try {
    await Like.create({ userId: req.user.id, targetType: 'comment', targetId: c.id });
  } catch (e) {
    if (e.name === 'SequelizeUniqueConstraintError') {
      await c.reload();
      return ok(res, { liked: true, likeCount: c.likeCount });
    }
    throw e;
  }
  await c.increment('likeCount');
  await c.reload();
  return ok(res, { liked: true, likeCount: c.likeCount });
}

module.exports = { listByPost, create, remove, toggleLike };
