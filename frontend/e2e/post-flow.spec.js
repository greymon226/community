import { test, expect } from '@playwright/test';
import { login, fillRichEditor, pickCategory, postButton, publishButton } from './helpers.js';

test.describe('发帖与详情', () => {
  test('发布新帖并在详情页查看', async ({ page }) => {
    const title = `E2E 测试帖 ${Date.now()}`;

    await login(page);
    await postButton(page).click();
    await expect(page.getByText('发布新帖')).toBeVisible();

    await page.getByLabel('标题').fill(title);
    await pickCategory(page, ['后端开发', 'Node.js']);
    await fillRichEditor(page, '这是 Playwright E2E 自动发布的测试正文。');

    await publishButton(page.locator('.ant-card .ant-form')).click();

    await expect(page).toHaveURL(/\/post\/\d+/);
    await expect(page.locator('h1')).toHaveText(title);
    await expect(page.getByText('这是 Playwright E2E 自动发布的测试正文')).toBeVisible();
  });

  test('在帖子详情页发表评论', async ({ page }) => {
    await login(page);
    await page.goto('/');

    const firstPost = page.locator('.post-card .title').first();
    await expect(firstPost).toBeVisible();
    await firstPost.click();

    const comment = `E2E 评论 ${Date.now()}`;
    const commentCard = page.locator('.ant-card').filter({ hasText: '评论' });
    await commentCard.getByPlaceholder('说点什么（至少 2 字）...').fill(comment);
    await publishButton(commentCard).click();

    await expect(page.getByText(comment)).toBeVisible({ timeout: 15_000 });
  });
});
