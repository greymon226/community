'use strict';

// 简单缓存抽象：优先使用 Redis，未配置时回退至内存 Map
const config = require('../config');

let client = null;
const memoryStore = new Map();

async function init() {
  if (!config.redisUrl) return;
  try {
    const { createClient } = require('redis');
    client = createClient({ url: config.redisUrl });
    client.on('error', (err) => console.error('[Redis] error:', err.message));
    await client.connect();
    console.log('[Redis] connected');
  } catch (err) {
    console.warn('[Redis] init failed, fallback to memory cache:', err.message);
    client = null;
  }
}

async function get(key) {
  if (client) {
    try {
      const v = await client.get(key);
      return v ? JSON.parse(v) : null;
    } catch (err) {
      fallbackToMemory(err);
    }
  }
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (entry.expireAt && entry.expireAt < Date.now()) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

async function set(key, value, ttlSeconds = 60) {
  if (client) {
    try {
      await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
      return;
    } catch (err) {
      fallbackToMemory(err);
    }
  }
  memoryStore.set(key, {
    value,
    expireAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
  });
}

async function del(key) {
  if (client) {
    try {
      await client.del(key);
      return;
    } catch (err) {
      fallbackToMemory(err);
    }
  }
  memoryStore.delete(key);
}

async function incr(key, ttlSeconds = 60) {
  if (client) {
    try {
      const value = await client.incr(key);
      if (value === 1 && ttlSeconds > 0) {
        await client.expire(key, ttlSeconds);
      }
      return value;
    } catch (err) {
      fallbackToMemory(err);
    }
  }

  const entry = memoryStore.get(key);
  const now = Date.now();
  const active = entry && (!entry.expireAt || entry.expireAt >= now);
  const current = active ? Number(entry.value) || 0 : 0;
  const value = current + 1;
  memoryStore.set(key, {
    value,
    expireAt: active ? entry.expireAt : ttlSeconds > 0 ? now + ttlSeconds * 1000 : null,
  });
  return value;
}

function fallbackToMemory(err) {
  console.warn('[Redis] operation failed, fallback to memory cache:', err.message);
  try {
    client?.disconnect?.();
  } catch {
    // ignore disconnect errors; memory cache is already taking over
  }
  client = null;
}

module.exports = { init, get, set, del, incr };
