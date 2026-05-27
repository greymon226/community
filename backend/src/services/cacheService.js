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
    const v = await client.get(key);
    return v ? JSON.parse(v) : null;
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
    await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
    return;
  }
  memoryStore.set(key, {
    value,
    expireAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
  });
}

async function del(key) {
  if (client) {
    await client.del(key);
    return;
  }
  memoryStore.delete(key);
}

module.exports = { init, get, set, del };
