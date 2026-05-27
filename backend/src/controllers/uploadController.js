'use strict';

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const config = require('../config');
const { ok, fail } = require('../utils/response');

fs.mkdirSync(config.upload.dir, { recursive: true });

const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.upload.dir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${uuid()}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED.has(ext)) return cb(new Error('不支持的文件类型'));
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.upload.maxMb * 1024 * 1024 },
});

function handle(req, res) {
  if (!req.file) return fail(res, '未收到文件');
  const url = `/uploads/${req.file.filename}`;
  return ok(res, { url, originalName: req.file.originalname, size: req.file.size });
}

module.exports = { upload, handle };
