import { expect, test } from '@playwright/test';

/**
 * dev-harness 浏览器面机判（pnpm e2e，按需——不进七道门禁）。
 *
 * 断言面＝DOM 挂载与交互逻辑：壳挂载形态、四页导航切换、跟随开关
 * 与状态行联动。选择器取仓内稳定锚（tt-shell 类名族、tab id、
 * 魔棒入口 id）；文案只锁语义关键词，整句单点在 task-profiles.ts。
 *
 * 壳结构事实（spec 断言依此设计）：初始收起（store.open=false），
 * 魔棒入口（tt-toolkit-wand-entry）点击展开；tab 容器首次激活挂载后
 * 保持挂载、以 tt-tab-container--visible 切换可见性——「切走」断言
 * 用可见容器归属，不用元素消失。
 */

const HARNESS_PATH = '/scripts/dev-harness/';

/** 打开壳并等 tab 条可交互（魔棒入口→toggleShell→tab 容器挂载）。 */
async function openShell(page: import('@playwright/test').Page): Promise<void> {
    await page.goto(HARNESS_PATH);
    await page.locator('#tt-toolkit-wand-entry').click();
    await expect(page.locator('.tt-tab-strip')).toBeVisible();
}

test('壳挂载：标题与版本在读', async ({ page }) => {
    await page.goto(HARNESS_PATH);
    // 壳初始收起＝display 隐藏，title 仍在 DOM（attached 断言不要求可见）
    await expect(page.locator('.tt-shell-title')).toHaveText('TT 工具箱');
    await expect(page.locator('.tt-shell-version')).toHaveText(/^v\d+\.\d+\.\d+$/);
});

test('四页导航：tab 激活切换且面板跟随', async ({ page }) => {
    await openShell(page);
    const tabs = page.locator('.tt-tab-strip [role=tab]');
    await expect(tabs).toHaveCount(4);
    await tabs.filter({ hasText: 'API' }).click();
    await expect(page.locator('.tt-tab-button--active')).toHaveText('API');
    // 可见容器归属 API（面板真切换）；跟随开关挂在 API 页任务模型卡
    await expect(page.locator('.tt-tab-container--visible[data-tab-id="api"]')).toBeVisible();
    await expect(page.locator('.tt-task-follow-toggle')).toBeVisible();
    // 切回选项生成页：可见容器换主（API 容器仍在 DOM 但不可见）
    await tabs.filter({ hasText: '选项生成' }).click();
    await expect(page.locator('.tt-tab-container--visible[data-tab-id="choice-settings"]')).toBeVisible();
    await expect(page.locator('.tt-task-follow-toggle')).toBeHidden();
});

test('跟随开关：状态行随开关联动', async ({ page }) => {
    await openShell(page);
    await page.locator('.tt-tab-strip [role=tab]').filter({ hasText: 'API' }).click();
    const toggle = page.locator('.tt-task-follow-toggle input');
    const status = page.locator('.tt-task-follow-status');
    // 关态基线（stubs 默认 followTavern=false）
    await expect(status).toContainText('未跟随');
    // 开：stub 连接 custom_url 为空 → 挡因可见（fail fast 的 UI 面）
    await toggle.check();
    await expect(status).toContainText('跟随不可用');
    // 关：回基线（开关可逆）
    await toggle.uncheck();
    await expect(status).toContainText('未跟随');
});
