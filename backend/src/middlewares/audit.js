'use strict';

const { AuditLog } = require('../models');

async function writeAudit(req, { action, targetType = '', targetId = null, detail = '' }) {
  try {
    await AuditLog.create({
      operatorId: req.user ? req.user.id : null,
      action,
      targetType,
      targetId,
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
      ip: req.ip || '',
    });
  } catch (e) {
    console.warn('[Audit] write failed:', e.message);
  }
}

module.exports = { writeAudit };
