'use strict';

const config = require('../config');
const { SensitiveWord } = require('../models');

let cachedWords = null;

async function loadWords() {
  if (cachedWords) return cachedWords;
  const list = await SensitiveWord.findAll();
  cachedWords = list.map((w) => ({ word: w.word, strategy: w.strategy }));
  // 兼容 .env 中配置的兜底词库
  for (const w of config.sensitiveWords) {
    if (!cachedWords.find((x) => x.word === w)) {
      cachedWords.push({ word: w, strategy: 'mask' });
    }
  }
  return cachedWords;
}

function invalidate() {
  cachedWords = null;
}

/**
 * 根据敏感词策略处理文本。
 * @returns {{cleanText, hits, blocked, needReview}}
 */
async function applySensitiveFilter(text) {
  const words = await loadWords();
  let cleanText = text;
  const hits = [];
  let blocked = false;
  let needReview = false;
  for (const { word, strategy } of words) {
    if (!word) continue;
    const re = new RegExp(escapeRegExp(word), 'gi');
    if (!re.test(cleanText)) continue;
    hits.push(word);
    if (strategy === 'block') blocked = true;
    if (strategy === 'review') needReview = true;
    if (strategy === 'mask') {
      cleanText = cleanText.replace(re, '*'.repeat(word.length));
    }
  }
  return { cleanText, hits, blocked, needReview };
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { applySensitiveFilter, invalidate, loadWords };
