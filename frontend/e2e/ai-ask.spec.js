import { test, expect } from '@playwright/test';
import { login } from './helpers.js';

test.describe('AI 站内问答', () => {
  test('打开抽屉并检索到站内相关讨论', async ({ page }) => {
    await login(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'AI 问答' }).click();
    await expect(page.getByText('AI 站内问答')).toBeVisible();

    await page.getByPlaceholder(/问点什么/).fill('Vue3 响应式');
    await page.getByRole('button', { name: '提问' }).click();

    // meta 帧先于 LLM 返回，本地 provider 也会展示 RAG 召回的「相关讨论」
    await expect(page.locator('.ant-drawer').getByText('相关讨论')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.ant-drawer').locator('a').first()).toBeVisible();
  });

  test('未登录时 AI 问答按钮不可用', async ({ page }) => {
    await page.goto('/');
    const btn = page.getByRole('button', { name: 'AI 问答' });
    await expect(btn).toBeDisabled();
  });
});
