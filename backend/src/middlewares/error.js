'use strict';

const { fail } = require('../utils/response');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[Error]', err);
  const status = err.status || 500;
  return fail(res, err.message || '服务异常', status === 500 ? 1 : status, status);
}

function notFound(req, res) {
  return fail(res, `资源不存在: ${req.originalUrl}`, 404, 404);
}

module.exports = { errorHandler, notFound };
