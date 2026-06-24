import { test, expect } from '@playwright/test';
import { login } from './helpers.js';

test.describe('浏览与搜索', () => {
  test('首页展示种子帖子列表', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.post-card').first()).toBeVisible();
    await expect(page.locator('.post-card .title').first()).not.toBeEmpty();
  });

  test('头部搜索关键词过滤帖子', async ({ page }) => {
    await page.goto('/');
    const search = page.getByPlaceholder('搜索标题/内容/作者');
    // 依赖 backend/seed.js 中的演示帖子关键词；修改 seed 时需同步更新。
    await search.fill('Vue');
    await search.press('Enter');

    await expect(page).toHaveURL(/keyword=Vue/);
    await expect(page.getByText('关键字: Vue')).toBeVisible();
    await expect(page.locator('.post-card').first()).toBeVisible();
  });

  test('点击帖子进入详情并显示互动按钮', async ({ page }) => {
    await login(page);
    // 依赖 backend/seed.js 中的 Docker 演示帖，确保搜索后有可进入详情的结果。
    await page.goto('/?keyword=Docker');

    const title = page.locator('.post-card .title').first();
    const titleText = await title.textContent();
    await title.click();

    await expect(page).toHaveURL(/\/post\/\d+/);
    if (titleText) {
      await expect(page.locator('h1')).toHaveText(titleText.trim());
    }
    await expect(page.getByRole('button', { name: '分享' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'AI 解读' })).toBeVisible();
  });
});
