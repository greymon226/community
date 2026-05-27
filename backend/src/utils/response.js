'use strict';

const ok = (res, data = null, message = 'ok') =>
  res.json({ code: 0, message, data });

const fail = (res, message = 'error', code = 1, status = 400) =>
  res.status(status).json({ code, message, data: null });

module.exports = { ok, fail };
