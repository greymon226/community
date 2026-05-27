'use strict';

// AI 调用监控埋点服务
//
// 设计要点：
//   - 不引入新表，复用 cacheService（Redis 优先 + 内存降级）
//   - 按"日 x 功能"维度滚动累计；TTL 8 天（保留近一周历史 + 当天）
//   - 监控数据天然容忍最终一致；轻微丢失不影响可用性
//   - 所有 record* 函数都是 fire-and-forget（即便挂了也不影响主业务）
//
// 数据结构（每个 key 对应一份 JSON）：
//   ai:metrics:<feature>:<YYYY-MM-DD> = {
//     total, success, failed, fallback, blocked, cached,
//     totalElapsedMs, totalPromptTokens, totalCompletionTokens
//   }

const cache = require('./cacheService');

const FEATURES = ['audit', 'explain', 'ask', 'assist', 'recommend'];

const DEFAULT_PRICE = {
  inputPerMTokens: 0.7,
  outputPerMTokens: 1.2,
};

function todayStr(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function keyOf(feature, date) {
  return `ai:metrics:${feature}:${date}`;
}

const EMPTY_BUCKET = () => ({
  total: 0,
  success: 0,
  failed: 0,
  fallback: 0,
  blocked: 0,
  cached: 0,
  totalElapsedMs: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
});

async function record(ev) {
  if (!ev || !FEATURES.includes(ev.feature)) return;
  const key = keyOf(ev.feature, todayStr());

  let bucket;
  try {
    bucket = (await cache.get(key)) || EMPTY_BUCKET();
  } catch (_e) {
    return; // 监控数据丢失不阻断业务
  }

  bucket.total += 1;
  if (ev.outcome === 'success') bucket.success += 1;
  else if (ev.outcome === 'failed') bucket.failed += 1;
  else if (ev.outcome === 'fallback') bucket.fallback += 1;
  else if (ev.outcome === 'blocked') bucket.blocked += 1;
  else if (ev.outcome === 'cached') bucket.cached += 1;

  if (typeof ev.elapsedMs === 'number' && ev.elapsedMs >= 0) {
    bucket.totalElapsedMs += ev.elapsedMs;
  }
  if (ev.usage && typeof ev.usage === 'object') {
    if (typeof ev.usage.prompt_tokens === 'number') {
      bucket.totalPromptTokens += ev.usage.prompt_tokens;
    }
    if (typeof ev.usage.completion_tokens === 'number') {
      bucket.totalCompletionTokens += ev.usage.completion_tokens;
    }
  }

  await cache.set(key, bucket, 8 * 24 * 3600).catch(() => {});
}

async function getAdminStats(days = 7) {
  const dates = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
    dates.push(todayStr(d));
  }

  const matrix = {};
  for (const date of dates) {
    matrix[date] = {};
    for (const feature of FEATURES) {
      const b = (await cache.get(keyOf(feature, date)).catch(() => null)) || EMPTY_BUCKET();
      matrix[date][feature] = b;
    }
  }

  const today = dates[dates.length - 1];
  const todayByFeature = {};
  for (const feature of FEATURES) {
    todayByFeature[feature] = decorate(matrix[today][feature]);
  }

  const last7Days = dates.map((date) => {
    const row = { date };
    for (const feature of FEATURES) {
      const b = matrix[date][feature];
      row[feature] = b.total;
    }
    return row;
  });

  let weekTotal = 0;
  let weekSuccess = 0;
  let weekFallback = 0;
  let weekBlocked = 0;
  let weekCached = 0;
  let weekElapsed = 0;
  let weekPromptTokens = 0;
  let weekCompletionTokens = 0;

  for (const date of dates) {
    for (const feature of FEATURES) {
      const b = matrix[date][feature];
      weekTotal += b.total;
      weekSuccess += b.success;
      weekFallback += b.fallback;
      weekBlocked += b.blocked;
      weekCached += b.cached;
      weekElapsed += b.totalElapsedMs;
      weekPromptTokens += b.totalPromptTokens;
      weekCompletionTokens += b.totalCompletionTokens;
    }
  }

  const todayTotal = FEATURES.reduce((acc, f) => acc + matrix[today][f].total, 0);
  const realLLMCalls = weekTotal - weekCached;
  const avgElapsedMs = realLLMCalls > 0 ? Math.round(weekElapsed / realLLMCalls) : 0;
  const successRate = weekTotal > 0 ? (weekSuccess + weekCached) / weekTotal : 1;

  const inputYuan = (weekPromptTokens / 1_000_000) * DEFAULT_PRICE.inputPerMTokens;
  const outputYuan = (weekCompletionTokens / 1_000_000) * DEFAULT_PRICE.outputPerMTokens;
  const cost = {
    estimatedYuan: Number((inputYuan + outputYuan).toFixed(4)),
    inputYuan: Number(inputYuan.toFixed(4)),
    outputYuan: Number(outputYuan.toFixed(4)),
    promptTokens: weekPromptTokens,
    completionTokens: weekCompletionTokens,
    pricePerMTokens: DEFAULT_PRICE,
    note: '依据 DeepSeek 官方公开单价估算，仅供参考；真实账单以 DeepSeek 后台为准',
  };

  return {
    today: todayByFeature,
    last7Days,
    totals: {
      todayTotal,
      weekTotal,
      weekSuccess,
      weekFallback,
      weekBlocked,
      weekCached,
      avgElapsedMs,
      successRate: Number(successRate.toFixed(4)),
    },
    cost,
  };
}

function decorate(b) {
  const realCalls = b.total - b.cached;
  return {
    ...b,
    avgElapsedMs: realCalls > 0 ? Math.round(b.totalElapsedMs / realCalls) : 0,
    successRate: b.total > 0 ? Number(((b.success + b.cached) / b.total).toFixed(4)) : 1,
  };
}

async function resetAll(days = 8) {
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = todayStr(new Date(now.getTime() - i * 24 * 3600 * 1000));
    for (const feature of FEATURES) {
      await cache.del(keyOf(feature, d)).catch(() => {});
    }
  }
}

module.exports = {
  record,
  getAdminStats,
  resetAll,
  FEATURES,
};
