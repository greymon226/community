'use strict';

const { Notification } = require('../models');

async function notify({ userId, fromUserId = null, type, title, content = '', payload = {} }) {
  if (!userId || userId === fromUserId) return null; // 不通知自己
  return Notification.create({
    userId,
    fromUserId,
    type,
    title,
    content,
    payload: JSON.stringify(payload),
  });
}

module.exports = { notify };
