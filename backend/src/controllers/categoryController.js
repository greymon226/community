'use strict';

const { Category } = require('../models');
const { ok, fail } = require('../utils/response');
const { cleanPlainText } = require('../utils/sanitize');
const { writeAudit } = require('../middlewares/audit');

// GET /categories  返回多级树
async function listTree(_req, res) {
  const list = await Category.findAll({
    where: { enabled: true },
    order: [['sort', 'ASC'], ['id', 'ASC']],
  });
  const map = new Map();
  list.forEach((c) => map.set(c.id, { ...c.toJSON(), children: [] }));
  const roots = [];
  for (const c of list) {
    const node = map.get(c.id);
    if (c.parentId && map.has(c.parentId)) {
      map.get(c.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return ok(res, roots);
}

// POST /admin/categories
async function create(req, res) {
  const { name, parentId = null, description = '', icon = '', sort = 0, visibility = '{}' } = req.body || {};
  if (!name) return fail(res, '名称不能为空');
  const cat = await Category.create({
    name: cleanPlainText(name).slice(0, 64),
    parentId,
    description: cleanPlainText(description).slice(0, 255),
    icon: String(icon).slice(0, 255),
    sort,
    visibility: typeof visibility === 'string' ? visibility : JSON.stringify(visibility),
  });
  await writeAudit(req, { action: 'category.create', targetType: 'category', targetId: cat.id, detail: cat.toJSON() });
  return ok(res, cat);
}

// PUT /admin/categories/:id
async function update(req, res) {
  const cat = await Category.findByPk(req.params.id);
  if (!cat) return fail(res, '分类不存在', 404, 404);
  const fields = ['name', 'description', 'icon', 'parentId', 'sort', 'enabled', 'visibility'];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      let v = req.body[f];
      if (f === 'visibility' && typeof v !== 'string') v = JSON.stringify(v);
      cat[f] = v;
    }
  }
  await cat.save();
  await writeAudit(req, { action: 'category.update', targetType: 'category', targetId: cat.id, detail: cat.toJSON() });
  return ok(res, cat);
}

// DELETE /admin/categories/:id
async function remove(req, res) {
  const cat = await Category.findByPk(req.params.id);
  if (!cat) return fail(res, '分类不存在', 404, 404);
  await cat.destroy();
  await writeAudit(req, { action: 'category.delete', targetType: 'category', targetId: cat.id });
  return ok(res, null, '已删除');
}

module.exports = { listTree, create, update, remove };
