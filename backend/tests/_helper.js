'use strict';

// 端到端测试公用工具

const BASE = process.env.E2E_BASE || 'http://localhost:4000/api';

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, body: data };
}

async function expectOk(promiseOrResp, label) {
  const r = await promiseOrResp;
  if (r.body?.code !== 0) {
    throw new Error(`[${label}] expected ok but got code=${r.body?.code} msg=${r.body?.message}`);
  }
  return r.body.data;
}

async function login(empNo, password) {
  const r = await api('POST', '/auth/login', { empNo, password });
  if (r.body?.code !== 0) throw new Error(`login ${empNo} failed: ${r.body?.message}`);
  return r.body.data.token;
}

async function ensureBackendUp() {
  try {
    const resp = await fetch((BASE.replace(/\/api$/, '')) + '/health');
    if (!resp.ok) throw new Error('health not ok');
    return true;
  } catch (e) {
    return false;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function step(label) {
  console.log(`\n>>> ${label}`);
}

function pass(label) {
  console.log(`    ✅ ${label}`);
}

module.exports = { api, expectOk, login, ensureBackendUp, assert, step, pass, BASE };
