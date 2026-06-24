import { test, expect } from '@playwright/test';
import { login, loginViaUi, loginForm, postButton, loginHeaderButton } from './helpers.js';

test.describe('认证流程', () => {
  test('未登录访问发帖页会跳转登录', async ({ page }) => {
    await page.goto('/post/new');
    await expect(page).toHaveURL(/\/login/);
  });

  test('Mock 登录成功并进入首页', async ({ page }) => {
    await loginViaUi(page);
    await expect(postButton(page)).toBeVisible();
    await expect(page.getByText('技术交流社区')).toBeVisible();
  });

  test('错误密码登录失败', async ({ page }) => {
    await page.goto('/login');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();

    const form = loginForm(page);
    await form.getByLabel('工号').fill('user001');
    await form.getByLabel('密码').fill('wrong-password');
    const respPromise = page.waitForResponse(
      (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
    );
    await form.locator('button[type="submit"]').click();
    const resp = await respPromise;
    expect(resp.status()).toBe(401);
    const body = await resp.json();
    expect(body.message).toContain('工号或密码错误');
    await expect(page).toHaveURL(/\/login/);
  });

  test('退出登录', async ({ page }) => {
    await login(page);
    await page.locator('.ant-avatar').click();
    await page.getByText('退出登录').click();
    await expect(page).toHaveURL(/\/login/);
    await expect(loginHeaderButton(page)).toBeVisible();
  });
});
