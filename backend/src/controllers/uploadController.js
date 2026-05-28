'use strict';

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const config = require('../config');
const { ok, fail } = require('../utils/response');

fs.mkdirSync(config.upload.dir, { recursive: true });

const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// --- Pure validation helpers (also exported via `__test` for property tests) ---

/**
 * Whether the filename's extension (lowercased) is in the upload whitelist.
 * Used by fileFilter and by P33 property tests.
 */
function isExtensionAllowed(originalName) {
  if (typeof originalName !== 'string') return false;
  const ext = path.extname(originalName).toLowerCase();
  return ALLOWED.has(ext);
}

/**
 * Whether the byte size is within the configured upper bound.
 * Mirrors multer's `limits.fileSize` semantics: size > limit is rejected.
 */
function isSizeAllowed(sizeBytes, maxMb) {
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) return false;
  if (typeof maxMb !== 'number' || !Number.isFinite(maxMb) || maxMb <= 0) return false;
  return sizeBytes <= maxMb * 1024 * 1024;
}

/**
 * Build the persisted filename in the form `<ts>-<uuid><ext>`. The extension
 * is taken (lowercased) from the original name so rejected uploads never
 * reach this function (fileFilter runs first).
 */
function buildFilename(originalName, now = Date.now(), id = uuid()) {
  const ext = path.extname(String(originalName)).toLowerCase();
  return `${now}-${id}${ext}`;
}

/**
 * Build the success response payload. The URL is always rooted at /uploads.
 */
function buildUploadResponse(filename, originalName, size) {
  return { url: `/uploads/${filename}`, originalName, size };
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.upload.dir),
  filename: (_req, file, cb) => {
    cb(null, buildFilename(file.originalname));
  },
});

const fileFilter = (_req, file, cb) => {
  if (!isExtensionAllowed(file.originalname)) return cb(new Error('不支持的文件类型'));
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.upload.maxMb * 1024 * 1024 },
});

function handle(req, res) {
  if (!req.file) return fail(res, '未收到文件');
  const payload = buildUploadResponse(req.file.filename, req.file.originalname, req.file.size);
  return ok(res, payload);
}

module.exports = {
  upload,
  handle,
  // Test-only exports — do not depend on these in production code.
  __test: {
    ALLOWED,
    isExtensionAllowed,
    isSizeAllowed,
    buildFilename,
    buildUploadResponse,
    fileFilter,
  },
};
