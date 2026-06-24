'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const casService = require('../../src/services/casService');

const { parseServiceValidateXml, buildCasUrl } = casService.__test;

test('casService: buildCasUrl resolves correctly', () => {
  const originalServerUrl = process.env.CAS_SERVER_URL;
  try {
    // 1) End with slash
    require('../../src/config').cas.serverUrl = 'https://cas.example.com/';
    assert.equal(buildCasUrl('login').toString(), 'https://cas.example.com/login');
    assert.equal(buildCasUrl('/login').toString(), 'https://cas.example.com/login');
    
    // 2) No trailing slash
    require('../../src/config').cas.serverUrl = 'https://cas.example.com';
    assert.equal(buildCasUrl('login').toString(), 'https://cas.example.com/login');
    assert.equal(buildCasUrl('/login').toString(), 'https://cas.example.com/login');
  } finally {
    require('../../src/config').cas.serverUrl = originalServerUrl;
  }
});

test('casService: parseServiceValidateXml parses success CAS XML without namespace', () => {
  const xml = `
    <serviceResponse>
      <authenticationSuccess>
        <user>admin</user>
        <attributes>
          <empNo>10001</empNo>
          <name>Administrator</name>
          <email>admin@example.com</email>
          <department>IT</department>
          <avatar>http://example.com/avatar.png</avatar>
        </attributes>
      </authenticationSuccess>
    </serviceResponse>
  `;
  const originalAttrs = require('../../src/config').cas.attrs;
  try {
    require('../../src/config').cas.attrs = {
      empNo: 'empNo',
      name: 'name',
      email: 'email',
      department: 'department',
      avatar: 'avatar'
    };

    const profile = parseServiceValidateXml(xml);
    assert.equal(profile.empNo, '10001');
    assert.equal(profile.name, 'Administrator');
    assert.equal(profile.email, 'admin@example.com');
    assert.equal(profile.department, 'IT');
    assert.equal(profile.avatar, 'http://example.com/avatar.png');
  } finally {
    require('../../src/config').cas.attrs = originalAttrs;
  }
});

test('casService: parseServiceValidateXml parses success CAS XML with namespace prefix cas:', () => {
  const xml = `
    <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
      <cas:authenticationSuccess>
        <cas:user>user01</cas:user>
        <cas:attributes>
          <cas:employeeNumber>20002</cas:employeeNumber>
          <cas:displayName>User One</cas:displayName>
          <cas:mail>user01@example.com</cas:mail>
          <cas:dept>HR</cas:dept>
          <cas:picture>http://example.com/pic.png</cas:picture>
        </cas:attributes>
      </cas:authenticationSuccess>
    </cas:serviceResponse>
  `;
  const originalAttrs = require('../../src/config').cas.attrs;
  try {
    require('../../src/config').cas.attrs = {
      empNo: 'empNo,employeeNumber,uid,user',
      name: 'name,displayName,cn',
      email: 'email,mail',
      department: 'department,departmentName,dept',
      avatar: 'avatar,picture'
    };

    const profile = parseServiceValidateXml(xml);
    assert.equal(profile.empNo, '20002');
    assert.equal(profile.name, 'User One');
    assert.equal(profile.email, 'user01@example.com');
    assert.equal(profile.department, 'HR');
    assert.equal(profile.avatar, 'http://example.com/pic.png');
  } finally {
    require('../../src/config').cas.attrs = originalAttrs;
  }
});

test('casService: parseServiceValidateXml handles authenticationFailure', () => {
  const xml = `
    <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
      <cas:authenticationFailure code="INVALID_TICKET">
        Ticket ST-18563-5g65a-cas not recognized
      </cas:authenticationFailure>
    </cas:serviceResponse>
  `;
  assert.throws(() => {
    parseServiceValidateXml(xml);
  }, /Ticket ST-18563-5g65a-cas not recognized/);
});

test('casService: parseServiceValidateXml fallback attributes when missing attributes block', () => {
  const xml = `
    <serviceResponse>
      <authenticationSuccess>
        <user>fallback_user</user>
      </authenticationSuccess>
    </serviceResponse>
  `;
  const profile = parseServiceValidateXml(xml);
  assert.equal(profile.empNo, 'fallback_user');
  assert.equal(profile.name, 'fallback_user');
  assert.equal(profile.nickname, 'fallback_user');
  assert.equal(profile.email, '');
  assert.equal(profile.department, '');
  assert.equal(profile.avatar, '');
});
