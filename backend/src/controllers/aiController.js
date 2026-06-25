'use strict';

const crypto = require('crypto');
const config = require('../config');
const { ok, fail } = require('../utils/response');
const ai = require('../services/aiService');
const search = require('../services/searchService');
const settings = require('../services/settingService');
const cache = require('../services/cacheService');
const moderation = require('../services/moderationService');
const metrics = require('../services/aiMetricsService');
const { writeAudit } = require('../middlewares/audit');

function askCacheKey(question) {
  const qHash = crypto.createHash('sha1').update(question.toLowerCase()).digest('hex').slice(0, 16);
  return `ai:ask:${qHash}`;
}

function buildAskCachePayload({
  question, answer, hasAnswer, citations, candidates, model, elapsedMs, usage, used, limit,
}) {
  return {
    question,
    answer,
    hasAnswer,
    citations,
    candidates,
    model,
    elapsedMs,
    usage,
    cached: false,
    quotaUsed: used + 1,
    quotaLimit: limit,
  };
}

async function reserveDailyQuota({ key, limit }) {
  if (!(limit > 0)) return { allowed: true, used: 0, limit };
  const used = await cache.incr(key, 24 * 3600);
  return { allowed: used <= limit, used, limit };
}

function initAskSse(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  return (type, payload) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ type, payload })}\n\n`);
  };
}

async function replayCachedAskStream(res, cached) {
  const send = initAskSse(res);
  send('meta', {
    candidates: cached.candidates || [],
    quotaUsed: cached.quotaUsed,
    quotaLimit: cached.quotaLimit,
    question: cached.question,
    cached: true,
  });
  const answer = cached.answer || '';
  if (answer) send('delta', { text: answer });
  send('done', {
    hasAnswer: cached.hasAnswer,
    citations: cached.citations || [],
    usage: cached.usage,
    full: answer,
    cached: true,
  });
  res.end();
}

/**
 * POST /api/ai/ask  body: { question, topN? }
 * 站内 RAG 问答
 *  - 受 aiAskEnabled 开关控制
 *  - 配额：每用户每日 aiAskPerUserDailyLimit 次
 *  - 缓存：相同问题 1 小时内复用（按 sha1(question) 归一化）
 *  - 检索：调用 searchService.searchForRAG 获取 Top-N 帖子作为上下文
 */
async function ask(req, res) {
  const enabled = await settings.get('aiAskEnabled');
  if (!enabled) return fail(res, 'AI 问答功能已关闭', 4003, 403);

  const question = String(req.body?.question || '').trim();
  if (!question) return fail(res, '请输入问题', 400);
  if (question.length > 500) return fail(res, '问题过长（500 字以内）', 400);

  // 敏感词兜底（不让用户直接把违规内容塞给模型）
  const filter = await moderation.applySensitiveFilter(question);
  if (filter.blocked) return fail(res, '问题包含敏感词，请修改后重试', 4001, 400);

  // Prompt injection 防护（仅对直达 AI 的接口生效，不影响 /api/posts 的正文讨论）
  const injection = ai.detectPromptInjection(question);
  if (injection.injected) {
    return fail(res, injection.reason, 4005, 400);
  }

  // 缓存命中（与流式接口共用同一 key）
  const cacheKey = askCacheKey(question);
  const cached = await cache.get(cacheKey);
  if (cached) {
    metrics.record({ feature: 'ask', outcome: 'cached' }).catch(() => {});
    return ok(res, { ...cached, cached: true });
  }

  // 配额
  const limit = await settings.get('aiAskPerUserDailyLimit');
  const today = new Date().toISOString().slice(0, 10);
  const quotaKey = `ai:ask:quota:${req.user.id}:${today}`;
  const quota = await reserveDailyQuota({ key: quotaKey, limit });
  if (!quota.allowed) {
    return fail(res, `今日 AI 问答次数已用完（上限 ${limit} 次），请明天再试`, 4004, 429);
  }

  // 1) 检索 Top-N 站内相关帖子
  const topN = Math.min(8, Math.max(3, parseInt(req.body?.topN || 5, 10)));
  const sources = await search.searchForRAG(question, { topN });

  // 2) 调 LLM
  let result;
  try {
    result = await ai.askWithRAG(question, sources);
  } catch (e) {
    return fail(res, `AI 调用失败：${e.message}`, 5001, 502);
  }

  // 3) 组装供前端展示的引用列表（只返回被引用过的帖子，附摘要与链接）
  const citedSet = new Set(result.citedSourceIds || []);
  const citations = sources
    .filter((s) => citedSet.has(s.id))
    .map((s) => ({
      id: s.id,
      title: s.title,
      summary: s.summary,
      author: s.author,
      category: s.category,
    }));

  // 候选列表（即便未被引用也展示，便于用户自行点击查阅）
  const candidates = sources.map((s) => ({
    id: s.id,
    title: s.title,
    summary: s.summary,
    author: s.author,
    category: s.category,
  }));

  const payload = buildAskCachePayload({
    question,
    answer: result.answer,
    hasAnswer: result.hasAnswer,
    citations,
    candidates,
    model: result.model,
    elapsedMs: result.elapsedMs,
    usage: result.usage,
    used: quota.used - 1,
    limit,
  });

  // 4) 缓存（1h）；配额已在调用前原子预占，避免并发绕过每日上限
  await cache.set(cacheKey, payload, 3600);

  await writeAudit(req, {
    action: 'ai.ask',
    targetType: 'ai',
    detail: { question, model: payload.model, cached: payload.cached }
  });

  return ok(res, payload);
}

module.exports = { ask, askStream, assist };

/**
 * POST /api/ai/ask/stream  body: { question, topN? }
 * SSE 流式版本的站内 RAG 问答
 *  - 帧格式：data: {"type":"meta"|"delta"|"done"|"error","payload":{...}}\n\n
 */
async function askStream(req, res) {
  const enabled = await settings.get('aiAskEnabled');
  if (!enabled) return fail(res, 'AI 问答功能已关闭', 4003, 403);

  const question = String(req.body?.question || '').trim();
  if (!question) return fail(res, '请输入问题', 400);
  if (question.length > 500) return fail(res, '问题过长（500 字以内）', 400);

  const filter = await moderation.applySensitiveFilter(question);
  if (filter.blocked) return fail(res, '问题包含敏感词，请修改后重试', 4001, 400);

  // Prompt injection 防护
  const injection = ai.detectPromptInjection(question);
  if (injection.injected) {
    return fail(res, injection.reason, 4005, 400);
  }

  // 缓存命中：复用非流式接口写入的缓存，以 SSE 回放
  const cacheKey = askCacheKey(question);
  const cached = await cache.get(cacheKey);
  if (cached) {
    metrics.record({ feature: 'ask', outcome: 'cached' }).catch(() => {});
    await writeAudit(req, {
      action: 'ai.ask_stream',
      targetType: 'ai',
      detail: { question, cached: true }
    });
    await replayCachedAskStream(res, cached);
    return;
  }

  // 配额（流式同样占用 ask 的额度，避免被绕过）
  const limit = await settings.get('aiAskPerUserDailyLimit');
  const today = new Date().toISOString().slice(0, 10);
  const quotaKey = `ai:ask:quota:${req.user.id}:${today}`;
  const quota = await reserveDailyQuota({ key: quotaKey, limit });
  if (!quota.allowed) {
    return fail(res, `今日 AI 问答次数已用完（上限 ${limit} 次），请明天再试`, 4004, 429);
  }

  // 检索
  const topN = Math.min(8, Math.max(3, parseInt(req.body?.topN || 5, 10)));
  const sources = await search.searchForRAG(question, { topN });
  const candidates = sources.map((s) => ({
    id: s.id, title: s.title, summary: s.summary, author: s.author, category: s.category,
  }));

  const send = initAskSse(res);

  const abort = new AbortController();
  let closed = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      closed = true;
      abort.abort();
    }
  });

  const emit = (type, payload) => {
    if (closed || res.writableEnded) return;
    send(type, payload);
  };

  // 先发 meta：候选 + 配额，让前端立刻渲染骨架
  emit('meta', { candidates, quotaUsed: quota.used, quotaLimit: limit, question });

  let full = '';
  let donePayload = null;
  try {
    await ai.streamAnswer(question, sources, (type, data) => {
      if (type === 'delta') {
        full += data.text;
        emit('delta', { text: data.text });
      } else if (type === 'done') {
        const citedSet = new Set(data.citedSourceIds || []);
        const citations = sources
          .filter((s) => citedSet.has(s.id))
          .map((s) => ({ id: s.id, title: s.title, summary: s.summary, author: s.author, category: s.category }));
        donePayload = {
          hasAnswer: data.hasAnswer,
          citations,
          usage: data.usage,
          full: data.full,
        };
        emit('done', donePayload);
      }
    }, { signal: abort.signal });
    if (!closed && donePayload) {
      await cache.set(cacheKey, buildAskCachePayload({
        question,
        answer: full || donePayload.full || '',
        hasAnswer: donePayload.hasAnswer,
        citations: donePayload.citations,
        candidates,
        model: config.ai.model,
        elapsedMs: null,
        usage: donePayload.usage,
        used: quota.used - 1,
        limit,
      }), 3600);

      await writeAudit(req, {
        action: 'ai.ask_stream',
        targetType: 'ai',
        detail: { question, cached: false }
      });
    }
  } catch (e) {
    if (!closed) emit('error', { message: e.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/**
 * POST /api/ai/assist  body: { kind: 'title'|'summary'|'explainCode', ... }
 * 写帖子时的辅助：标题改写 / 生成摘要 / 解释代码
 *  - 共享一个 aiAssistEnabled 开关
 *  - 配额：每用户每日 aiAssistPerUserDailyLimit
 */
async function assist(req, res) {
  const enabled = await settings.get('aiAssistEnabled');
  if (!enabled) return fail(res, 'AI 写作助手已关闭', 4003, 403);

  const limit = await settings.get('aiAssistPerUserDailyLimit');
  const today = new Date().toISOString().slice(0, 10);
  const quotaKey = `ai:assist:quota:${req.user.id}:${today}`;
  const quota = await reserveDailyQuota({ key: quotaKey, limit });
  if (!quota.allowed) {
    return fail(res, `今日 AI 写作助手次数已用完（上限 ${limit} 次），请明天再试`, 4004, 429);
  }

  const kind = String(req.body?.kind || '').trim();

  // Prompt injection 防护：把所有可能直达模型的入参字段都检查一遍
  const fieldsToCheck = [req.body?.title, req.body?.content, req.body?.snippet]
    .filter((v) => typeof v === 'string' && v.length > 0);
  for (const field of fieldsToCheck) {
    const injection = ai.detectPromptInjection(field);
    if (injection.injected) {
      return fail(res, injection.reason, 4005, 400);
    }
  }

  let result;
  try {
    if (kind === 'title') {
      result = await ai.assistTitle({ title: req.body.title || '', content: req.body.content || '' });
    } else if (kind === 'summary') {
      result = await ai.summarize({ title: req.body.title || '', content: req.body.content || '' });
    } else if (kind === 'explainCode') {
      result = await ai.explainCode({ snippet: req.body.snippet || '', language: req.body.language || '' });
    } else {
      return fail(res, `不支持的 kind: ${kind}`, 400);
    }
  } catch (e) {
    return fail(res, `AI 调用失败：${e.message}`, 5001, 502);
  }

  await writeAudit(req, {
    action: `ai.assist.${kind}`,
    targetType: 'ai',
    detail: { kind }
  });

  return ok(res, { kind, ...result, quotaUsed: quota.used, quotaLimit: limit });
}
