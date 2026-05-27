'use strict';

const sanitizeHtml = require('sanitize-html');

// 富文本白名单：兼容代码高亮、图片、链接、表格
const richTextOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'div', 'span',
    'strong', 'em', 'u', 's', 'blockquote',
    'ul', 'ol', 'li',
    'a', 'img',
    'pre', 'code',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    code: ['class'],
    pre: ['class'],
    span: ['class'],
    div: ['class'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
  },
  allowedSchemes: ['http', 'https', 'data', 'mailto'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
};

const cleanRichText = (html = '') => sanitizeHtml(String(html), richTextOptions);

const cleanPlainText = (str = '') =>
  sanitizeHtml(String(str), { allowedTags: [], allowedAttributes: {} }).trim();

const buildSummary = (html, max = 160) => {
  const text = cleanPlainText(html);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

module.exports = { cleanRichText, cleanPlainText, buildSummary };
