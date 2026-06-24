import { expect } from '@playwright/test';

/** 顶栏 Ant Design 按钮的可访问名称可能是「发 帖」 */
export const postButton = (page) => page.getByRole('button', { name: /发\s*帖/ });

/** 顶栏未登录时的「登 录」 */
export const loginHeaderButton = (page) => page.locator('.app-header').getByRole('button', { name: /登\s*录/ });

/** 表单提交「发 布」 */
export const publishButton = (scope) => scope.getByRole('button', { name: /发\s*布/ });

/** @returns {import('@playwright/test').Locator} */
export function loginForm(page) {
  return page.locator('.ant-card .ant-form');
}

/**
 * 通过 API + localStorage 注入登录态，稳定用于需要登录的用例。
 * @param {import('@playwright/test').Page} page
 * @param {{ empNo?: string, password?: string }} [opts]
 */
export async function login(page, { empNo = 'user001', password = 'user123' } = {}) {
  const resp = await page.request.post('/api/auth/login', {
    data: { empNo, password },
  });
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();
  expect(body.code).toBe(0);

  const { token, user } = body.data;
  await page.goto('/');
  await page.evaluate(({ token, user }) => {
    localStorage.setItem(
      'community-auth',
      JSON.stringify({ state: { token, user }, version: 0 }),
    );
  }, { token, user });
  await page.reload();
  await expect(postButton(page)).toBeVisible();
}

/**
 * 走 UI 表单登录，用于专门验证登录页交互。
 * @param {import('@playwright/test').Page} page
 * @param {{ empNo?: string, password?: string }} [opts]
 */
export async function loginViaUi(page, { empNo = 'user001', password = 'user123' } = {}) {
  await page.goto('/login');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();

  const form = loginForm(page);
  await form.getByLabel('工号').fill(empNo);
  await form.getByLabel('密码').fill(password);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/**
 * @param {import('@playwright/test').Page} page
 */
export async function fillRichEditor(page, text) {
  const editor = page.locator('.rich-editor-body');
  await editor.click();
  await editor.evaluate((el, value) => {
    el.innerHTML = `<p>${value}</p>`;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, text);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} pathLabels cascader 路径，如 ['后端开发', 'Node.js']
 */
export async function pickCategory(page, pathLabels) {
  await page.locator('.ant-cascader').click();
  for (const label of pathLabels) {
    await page.locator('.ant-cascader-menus').getByText(label, { exact: true }).click();
  }
}
