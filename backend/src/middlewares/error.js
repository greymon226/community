'use strict';

const { fail } = require('../utils/response');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[Error]', err);
  const status = err.status || 500;
  // 生产环境不暴露内部错误细节给客户端
  const message =
    process.env.NODE_ENV === 'production' && status === 500
      ? '服务器内部错误，请稍后重试'
      : err.message || '服务异常';
  return fail(res, message, status === 500 ? 1 : status, status);
}

function notFound(req, res) {
  return fail(res, `资源不存在: ${req.originalUrl}`, 404, 404);
}

module.exports = { errorHandler, notFound };
