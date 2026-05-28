'use strict';

// 搜索服务抽象：默认基于数据库 LIKE，可替换为 Elasticsearch
const { Op, literal } = require('sequelize');
const { Post, User, Category, Tag } = require('../models');
const { cleanPlainText } = require('../utils/sanitize');

async function searchPosts({ keyword, categoryId, authorId, tag, sort = 'latest', page = 1, pageSize = 10 }) {
  const where = { status: 'published' };
  if (keyword) {
    where[Op.and] = [buildLikeSearchCondition(keyword, ['title', 'content', 'summary'])];
  }
  if (categoryId) where.categoryId = categoryId;
  if (authorId) where.authorId = authorId;

  const include = [
    { model: User, as: 'author', attributes: ['id', 'name', 'nickname', 'avatar', 'department'] },
    { model: Category, as: 'category', attributes: ['id', 'name'] },
    { model: Tag, as: 'tags', attributes: ['id', 'name'], through: { attributes: [] } },
  ];

  if (tag) {
    include[2].where = { name: tag };
    include[2].required = true;
  }

  let order;
  switch (sort) {
    case 'hot':
      order = [['pinned', 'DESC'], ['likeCount', 'DESC'], ['viewCount', 'DESC']];
      break;
    case 'comments':
      order = [['pinned', 'DESC'], ['commentCount', 'DESC']];
      break;
    case 'featured':
      order = [['featured', 'DESC'], ['createdAt', 'DESC']];
      break;
    case 'latest':
    default:
      order = [['pinned', 'DESC'], ['createdAt', 'DESC']];
  }

  const offset = (page - 1) * pageSize;
  const { rows, count } = await Post.findAndCountAll({
    where,
    include,
    order,
    offset,
    limit: pageSize,
    distinct: true,
  });

  return { items: rows, total: count, page, pageSize };
}

module.exports = { searchPosts, searchForRAG };
// Internal helpers exposed only for unit tests (tests/unit/*.test.js).
// Do NOT use these in production code paths.
module.exports.__test = { tokenize, extractSnippet };

/**
 * 为 RAG 准备 Top-N 相关帖子，返回结构化、可直接喂给 LLM 的上下文片段
 * 使用：分词 -> 多关键词 OR 检索 -> 提取命中片段 -> 限制长度
 * 后续若接 ES：把这里换成向量/混合检索即可，调用方接口不变
 */
async function searchForRAG(question, { topN = 5 } = {}) {
  const tokens = tokenize(question);
  if (tokens.length === 0) return [];

  const orClauses = [];
  for (const t of tokens) {
    orClauses.push(buildLikeSearchCondition(t, ['title', 'content', 'summary']));
  }

  // 召回更多候选，再用本地评分排序后取 topN
  const candidates = await Post.findAll({
    where: { status: 'published', [Op.or]: orClauses },
    include: [
      { model: User, as: 'author', attributes: ['id', 'nickname', 'name'] },
      { model: Category, as: 'category', attributes: ['id', 'name'] },
    ],
    order: [['likeCount', 'DESC'], ['createdAt', 'DESC']],
    limit: Math.max(20, topN * 4),
  });

  const scored = candidates
    .map((p) => {
      const plainTitle = (p.title || '').toLowerCase();
      const plainContent = cleanPlainText(p.content || '').toLowerCase();
      let score = 0;
      for (const t of tokens) {
        const lt = t.toLowerCase();
        if (plainTitle.includes(lt)) score += 5; // 标题命中权重高
        const occurrences = plainContent.split(lt).length - 1;
        score += Math.min(occurrences, 5); // 正文命中次数（封顶 5 防止刷分）
      }
      // 互动质量微加权
      score += Math.log10(1 + (p.likeCount || 0)) * 0.3;
      return { post: p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return scored.map(({ post }) => ({
    id: post.id,
    title: post.title,
    summary: post.summary || '',
    snippet: extractSnippet(cleanPlainText(post.content || ''), tokens, 600),
    author: post.author?.nickname || post.author?.name || '',
    category: post.category?.name || '',
    likeCount: post.likeCount,
    commentCount: post.commentCount,
    createdAt: post.createdAt,
  }));
}

// 简易中英文分词：保留 2 字以上中文词、3 字以上英文/数字 token
function tokenize(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  // 拆中英混合：英文/数字按非字母分割，中文按 2-3 字滑窗
  const enTokens = (s.match(/[a-zA-Z0-9_+#.\-]{3,}/g) || []).map((x) => x.toLowerCase());

  const zhSegments = s.split(/[^\u4e00-\u9fa5]+/).filter(Boolean);
  const zhTokens = new Set();
  for (const seg of zhSegments) {
    if (seg.length <= 4) {
      if (seg.length >= 2) zhTokens.add(seg);
    } else {
      // 滑窗 2-gram + 整段
      for (let i = 0; i < seg.length - 1; i++) zhTokens.add(seg.slice(i, i + 2));
      zhTokens.add(seg);
    }
  }
  // 去停用词、去重，保留前 8 个
  const STOP = new Set(['the', 'and', 'for', 'how', 'why', 'what', 'with', 'this', 'that', '怎么', '如何', '为什么', '是不是']);
  const merged = [...new Set([...enTokens, ...zhTokens])].filter((t) => !STOP.has(t));
  return merged.slice(0, 8);
}

// 围绕首个命中关键词截取窗口，让 LLM 看到最相关的段落
function extractSnippet(text, tokens, maxLen = 600) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0) { pos = i; break; }
  }
  if (pos < 0) return text.slice(0, maxLen);
  const start = Math.max(0, pos - Math.floor(maxLen / 3));
  const end = Math.min(text.length, start + maxLen);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

function escapeLikeKeyword(value) {
  // 使用 $ 作为 ESCAPE 字符（兼容 MySQL + SQLite）
  return String(value || '').replace(/[$%_]/g, (ch) => `$${ch}`);
}

function buildLikeSearchCondition(keyword, fields) {
  const pattern = `%${escapeLikeKeyword(keyword)}%`;
  const escapedPattern = Post.sequelize.escape(pattern);
  const conditions = fields.map((field) => `\`Post\`.\`${field}\` LIKE ${escapedPattern} ESCAPE '$'`);
  return literal(`(${conditions.join(' OR ')})`);
}
