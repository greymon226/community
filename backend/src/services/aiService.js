'use strict';

// AI 服务：内容审核 + 智能推荐
// - provider=deepseek/openai：调用真实大模型（OpenAI 兼容协议）
// - provider=local 或未配置 API_KEY：使用本地规则做兜底审核
// - 真实模型调用失败会自动降级到本地规则，保证业务不中断

const config = require('../config');
const { Post, Tag } = require('../models');
const { Op } = require('sequelize');
const { cleanPlainText } = require('../utils/sanitize');

// 本地兜底用的风险词
const RISK_KEYWORDS = [
  '色情', '暴力', '辱骂', '人身攻击', '广告推广', '加微信',
  'http://t.me/', '兼职刷单', '非法集资',
];

/**
 * 内容审核入口
 * 返回 { status: 'pass'|'review'|'blocked', reason, raw? }
 */
async function auditContent({ title = '', content = '' }) {
  const cleanTitle = cleanPlainText(title);
  const cleanContent = cleanPlainText(content);

  // 1. 长度兜底：内容过短无需调模型
  if ((cleanTitle + cleanContent).trim().length < 5) {
    return { status: 'review', reason: '内容过短，疑似无效内容' };
  }

  // 2. 选择 provider
  const provider = config.ai.provider;
  if ((provider === 'deepseek' || provider === 'openai') && config.ai.apiKey) {
    try {
      return await auditWithLLM(cleanTitle, cleanContent);
    } catch (err) {
      console.warn('[AI] LLM audit failed, fallback to local rules:', err.message);
      // 失败降级
    }
  }

  // 3. 本地规则兜底
  return auditWithLocalRules(cleanTitle, cleanContent);
}

function auditWithLocalRules(title, content) {
  const text = `${title} ${content}`.toLowerCase();
  for (const kw of RISK_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) {
      return { status: 'review', reason: `命中本地风险词：${kw}` };
    }
  }
  return { status: 'pass', reason: '' };
}

/**
 * 调用 DeepSeek / OpenAI 兼容的 Chat Completions 接口做审核
 * 让模型返回结构化 JSON: { status, reason, categories[] }
 */
async function auditWithLLM(title, content) {
  const url = `${config.ai.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const truncated = `${title}\n\n${content}`.slice(0, 4000); // 控制 token

  const body = {
    model: config.ai.model,
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          '你是企业技术社区的内容审核员。判断帖子是否违反社区规范，' +
          '违规类别包含：政治敏感、色情低俗、暴力血腥、人身攻击/辱骂、广告推广/引流、' +
          '诈骗/非法、泄露公司机密、明显的虚假信息。' +
          '严格只返回 JSON，不要解释，结构为 ' +
          '{"status":"pass"|"review"|"blocked","reason":"<不超过60字的中文理由>","categories":["..."]}。' +
          '没有问题则 status=pass、reason="" categories=[]；' +
          '存在轻度违规或不确定时 status=review；' +
          '明显严重违规时 status=blocked。',
      },
      {
        role: 'user',
        content: `请审核以下技术社区帖子：\n标题：${title}\n正文：${content}`.slice(0, 6000) || truncated,
      },
    ],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.ai.timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content || '';
  const parsed = safeParseJSON(raw);
  if (!parsed) throw new Error(`LLM 返回非 JSON: ${raw.slice(0, 200)}`);

  const status = ['pass', 'review', 'blocked'].includes(parsed.status) ? parsed.status : 'review';
  const reason = String(parsed.reason || '').slice(0, 200);
  return { status, reason, raw: parsed };
}

function safeParseJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* fallthrough */ }
  // 容错：模型偶尔会包 markdown 代码块
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (e) { return null; }
  }
  return null;
}

/**
 * 通用的 LLM 结构化调用
 * @returns 解析后的 JSON 对象
 */
async function callLLMJSON({ system, user, temperature = 0.3 }) {
  if (!((config.ai.provider === 'deepseek' || config.ai.provider === 'openai') && config.ai.apiKey)) {
    throw new Error('AI provider 未配置');
  }
  const url = `${config.ai.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const body = {
    model: config.ai.model,
    response_format: { type: 'json_object' },
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.ai.timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content || '';
  const parsed = safeParseJSON(raw);
  if (!parsed) throw new Error(`LLM 返回非 JSON: ${raw.slice(0, 200)}`);
  return { parsed, usage: data.usage || null };
}

/**
 * 帖子 AI 解读：总结 + 要点 + 改进建议 + 延伸问题
 * @returns { summary, keyPoints, suggestions, questions, model, elapsedMs }
 */
async function explainPost({ title, content }) {
  const cleanTitle = cleanPlainText(title || '').slice(0, 200);
  const cleanContent = cleanPlainText(content || '').slice(0, 6000);

  if (!cleanContent || cleanContent.length < 20) {
    throw new Error('内容过短，无需 AI 解读');
  }

  const system =
    '你是企业技术社区的资深技术专家。对用户给出的帖子进行结构化解读，帮助读者快速吸收要点。' +
    '严格只返回 JSON，不解释，结构如下：' +
    '{' +
    '"summary":"2-3句话的中文核心摘要",' +
    '"keyPoints":["要点1","要点2","要点3"],' +
    '"suggestions":["可优化或可补充之处1","..."],' +
    '"questions":["读者可能想进一步追问的问题1","..."]' +
    '}。' +
    'keyPoints 3-6 条；suggestions、questions 各 2-4 条。' +
    '若帖子是代码相关，请在 suggestions 中指出代码隐患或最佳实践；' +
    '若是经验分享，suggestions 给出补充建议或不同视角。' +
    '语气专业、克制，不要复述原文，不要使用 markdown。';

  const user = `请解读以下帖子：\n标题：${cleanTitle}\n正文：${cleanContent}`;

  const t0 = Date.now();
  const { parsed, usage } = await callLLMJSON({ system, user, temperature: 0.4 });

  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean).map((s) => String(s).slice(0, 300)) : []);
  return {
    summary: String(parsed.summary || '').slice(0, 600),
    keyPoints: arr(parsed.keyPoints).slice(0, 8),
    suggestions: arr(parsed.suggestions).slice(0, 6),
    questions: arr(parsed.questions).slice(0, 6),
    model: config.ai.model,
    usage,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * 站内 RAG 问答：把用户问题 + 站内 Top-N 相关帖子作为上下文，让 LLM 基于站内内容作答
 * @param {string} question 用户问题
 * @param {Array} sources 检索到的帖子上下文，结构：[{ id, title, summary, snippet, author, category, url }]
 * @returns { answer, citedSourceIds, hasAnswer, model, usage, elapsedMs }
 */
async function askWithRAG(question, sources = []) {
  const q = cleanPlainText(String(question || '')).slice(0, 500);
  if (!q) throw new Error('问题不能为空');

  if (sources.length === 0) {
    return {
      answer: '站内还没有找到相关讨论。建议把问题发到对应板块求助，或换一个关键词再搜搜。',
      citedSourceIds: [],
      hasAnswer: false,
      model: config.ai.model,
      usage: null,
      elapsedMs: 0,
    };
  }

  // 拼接上下文（编号便于模型在回答中引用）
  const ctx = sources
    .map((s, i) => {
      const head = `[${i + 1}] 帖子#${s.id} 《${(s.title || '').slice(0, 80)}》`;
      const meta = `分类: ${s.category || '-'} 作者: ${s.author || '-'}`;
      const body = (s.snippet || s.summary || '').slice(0, 800);
      return `${head}\n${meta}\n${body}`;
    })
    .join('\n\n---\n\n');

  const system =
    '你是企业技术社区的智能问答助手。请严格基于下面提供的"站内帖子上下文"回答用户的问题，' +
    '不要编造站外信息，不要使用预训练里通用的解决方案，除非上下文里没有相关内容。' +
    '严格只返回 JSON，不要 markdown 包裹。结构：' +
    '{' +
    '"hasAnswer":true|false,' +
    '"answer":"<不超过400字的中文回答；如果上下文足够回答就基于上下文回答；如果不足请说明并建议用户去对应板块发帖求助>",' +
    '"citedSourceIds":[<answer 中引用过的上下文编号，从 1 开始的整数，对应上下文里的 [1] [2] ...>]' +
    '}。' +
    '要求：' +
    '1) 回答尽量结合上下文中具体的做法、踩坑、结论；' +
    '2) 在关键论点后用方括号编号标注引用，例如：使用 useMemo 可以缓存计算结果 [1]；' +
    '3) 若上下文与问题无关，hasAnswer=false，answer 给出友好引导，citedSourceIds=[]；' +
    '4) 不要复述上下文，不要列出原帖标题，不要解释自己。';

  const user = `用户问题：${q}\n\n站内帖子上下文：\n${ctx}`;

  const t0 = Date.now();
  const { parsed, usage } = await callLLMJSON({ system, user, temperature: 0.3 });
  const validIds = new Set(sources.map((s) => s.id));
  const rawCited = Array.isArray(parsed.citedSourceIds) ? parsed.citedSourceIds.map(Number) : [];
  // 兼容两种语义：① 真实帖子 id  ② 上下文中的编号 [1..N]
  const cited = [...new Set(
    rawCited
      .map((n) => {
        if (validIds.has(n)) return n;
        // 当作编号处理（1-based）
        const idx = n - 1;
        if (idx >= 0 && idx < sources.length) return sources[idx].id;
        return null;
      })
      .filter((x) => x !== null)
  )];
  return {
    answer: String(parsed.answer || '').slice(0, 1500),
    citedSourceIds: cited,
    hasAnswer: !!parsed.hasAnswer,
    model: config.ai.model,
    usage,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * 写帖子辅助：标题改写
 * @returns { suggestions: string[] }
 */
async function assistTitle({ title, content }) {
  const t = cleanPlainText(title || '').slice(0, 200);
  const c = cleanPlainText(content || '').slice(0, 4000);
  if (!t && !c) throw new Error('标题与正文不能同时为空');
  const system =
    '你是企业技术社区的资深编辑。基于用户的标题与正文，给出 3-5 个更清晰、更吸引点击但不夸张的标题候选。' +
    '严格只返回 JSON：{"suggestions":["...","..."]}。' +
    '要求：' +
    '1) 与原意一致，不偏题；' +
    '2) 控制在 30 字以内；' +
    '3) 突出技术关键词；' +
    '4) 避免标题党、感叹号、emoji；' +
    '5) 第一个候选偏简洁，后面可逐步加入更多上下文。';
  const user = `当前标题：${t || '（未填写）'}\n当前正文：${c || '（空）'}`;
  const { parsed } = await callLLMJSON({ system, user, temperature: 0.5 });
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean).map((s) => String(s).slice(0, 100)) : []);
  return { suggestions: arr(parsed.suggestions).slice(0, 5) };
}

/**
 * 写帖子辅助：生成摘要
 * @returns { summary: string }
 */
async function summarize({ title, content }) {
  const t = cleanPlainText(title || '').slice(0, 200);
  const c = cleanPlainText(content || '').slice(0, 6000);
  if ((t + c).length < 20) throw new Error('内容过短，无需摘要');
  const system =
    '你是企业技术社区的资深编辑。请基于标题与正文生成 1-2 句话的中文摘要，' +
    '不超过 120 字，不要使用 markdown，不要复述标题，不要展开次要细节。' +
    '严格只返回 JSON：{"summary":"..."}。';
  const user = `标题：${t}\n正文：${c}`;
  const { parsed } = await callLLMJSON({ system, user, temperature: 0.3 });
  return { summary: String(parsed.summary || '').slice(0, 300) };
}

/**
 * 写帖子辅助：解释一段代码 / 文本片段
 * @returns { explanation, risks: string[], suggestions: string[] }
 */
async function explainCode({ snippet, language = '' }) {
  const code = String(snippet || '').slice(0, 4000);
  if (!code.trim()) throw new Error('代码片段不能为空');
  const system =
    '你是资深开发者。请解释下方代码片段：' +
    '1) 用 2-4 句话说明它在做什么；' +
    '2) 列出潜在问题或踩坑（risks）；' +
    '3) 列出可改进的最佳实践（suggestions）。' +
    '严格只返回 JSON：{"explanation":"...","risks":["..."],"suggestions":["..."]}。' +
    '语言中文，risks/suggestions 各 0-4 条，过短或无问题时可为空。';
  const user = `语言提示：${language || '未指定'}\n代码：\n${code}`;
  const { parsed } = await callLLMJSON({ system, user, temperature: 0.3 });
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean).map((s) => String(s).slice(0, 300)) : []);
  return {
    explanation: String(parsed.explanation || '').slice(0, 1000),
    risks: arr(parsed.risks).slice(0, 6),
    suggestions: arr(parsed.suggestions).slice(0, 6),
  };
}

/**
 * 流式版本的站内 RAG 问答
 * @param {function(string, object)} onChunk(type, data)
 *   type: 'meta' | 'delta' | 'done' | 'error'
 *   data: { text? } | { meta } | { full, usage, citedSourceIds }
 */
async function streamAnswer(question, sources, onChunk) {
  const q = cleanPlainText(String(question || '')).slice(0, 500);
  if (!q) throw new Error('问题不能为空');

  if (!((config.ai.provider === 'deepseek' || config.ai.provider === 'openai') && config.ai.apiKey)) {
    throw new Error('AI provider 未配置');
  }

  // 没有上下文时直接返回引导文案，无需调模型
  if (sources.length === 0) {
    const text = '站内还没有找到相关讨论。建议把问题发到对应板块求助，或换一个关键词再搜搜。';
    onChunk('delta', { text });
    onChunk('done', { full: text, hasAnswer: false, citedSourceIds: [], usage: null });
    return;
  }

  const ctx = sources
    .map((s, i) => {
      const head = `[${i + 1}] 帖子#${s.id} 《${(s.title || '').slice(0, 80)}》`;
      const meta = `分类: ${s.category || '-'} 作者: ${s.author || '-'}`;
      const body = (s.snippet || s.summary || '').slice(0, 800);
      return `${head}\n${meta}\n${body}`;
    })
    .join('\n\n---\n\n');

  const system =
    '你是企业技术社区的智能问答助手。基于"站内帖子上下文"用中文回答用户问题，' +
    '不要编造、不要复述上下文。要求：' +
    '1) 总长度 400 字以内；' +
    '2) 在关键论点后用方括号编号标注引用，例如：使用 toRefs 保持响应式 [1]；' +
    '3) 不使用 markdown 标题、不要列原帖标题、不要解释你自己；' +
    '4) 若上下文与问题完全无关，只输出一句话引导用户去对应板块发帖求助。' +
    '直接输出回答正文，不要额外的前缀或包裹。';

  const user = `用户问题：${q}\n\n站内帖子上下文：\n${ctx}`;

  const url = `${config.ai.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const body = {
    model: config.ai.model,
    stream: true,
    temperature: 0.3,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.ai.timeoutMs * 2);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }

  if (!resp.ok || !resp.body) {
    clearTimeout(timer);
    const text = await resp.text().catch(() => '');
    throw new Error(`LLM stream HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  // 解析 SSE 流（OpenAI 兼容协议：每行 "data: {json}" 或 "data: [DONE]"）
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let usage = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') break;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        const delta = chunk?.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          onChunk('delta', { text: delta });
        }
        if (chunk.usage) usage = chunk.usage;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  // 解析回答里出现的 [n] 编号 → 真实帖子 ID
  const seenIdx = [...full.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]));
  const cited = [...new Set(
    seenIdx
      .map((n) => (n >= 1 && n <= sources.length ? sources[n - 1].id : null))
      .filter((x) => x !== null)
  )];
  const hasAnswer = full.trim().length > 0 && cited.length > 0;
  onChunk('done', { full, hasAnswer, citedSourceIds: cited, usage });
}

/**
 * 智能推荐：基于用户技术标签 + 帖子标签匹配
 */
async function recommendPosts(user, limit = 10) {
  const tags = (user?.techTags || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (tags.length === 0) {
    return Post.findAll({
      where: { status: 'published' },
      order: [['likeCount', 'DESC'], ['createdAt', 'DESC']],
      limit,
    });
  }
  const matchedTags = await Tag.findAll({ where: { name: { [Op.in]: tags } } });
  if (matchedTags.length === 0) {
    return Post.findAll({
      where: { status: 'published' },
      order: [['likeCount', 'DESC']],
      limit,
    });
  }
  const tagIds = matchedTags.map((t) => t.id);
  return Post.findAll({
    where: { status: 'published' },
    include: [{ association: 'tags', where: { id: { [Op.in]: tagIds } }, required: true }],
    order: [['likeCount', 'DESC'], ['createdAt', 'DESC']],
    limit,
  });
}

module.exports = { auditContent, recommendPosts, explainPost, askWithRAG, streamAnswer, assistTitle, summarize, explainCode };
