import { defineConfig } from '@playwright/test';

/**
 * dev-harness 浏览器面机判（按需跑：pnpm e2e——不进七道门禁，改壳层/
 * UI 时手动跑）。node 冒烟测逻辑层（无 DOM），本配置补 DOM 挂载与
 * 交互面：壳挂载、三页导航、跟随开关状态行联动。
 *
 * 边界（与仓内认知一致）：harness 无宿主样式表，CSS 依赖型 bug 不在
 * 此面——壳层样式仍须真机验。内核经 @playwright/test 自管
 * （首次缺内核跑 pnpm exec playwright install chromium）。
 */
export default defineConfig({
    testDir: './scripts/dev-harness/e2e',
    timeout: 30_000,
    workers: 1,
    reporter: [['list']],
    use: {
        baseURL: 'http://127.0.0.1:4319',
        headless: true,
    },
    // 独立端口（避开 serve.mjs 默认 4173 的手工调试实例）；reuseExistingServer
    // 只会复用本配置自己起的实例——手工 serve 的 4173 不受影响
    webServer: {
        command: 'node scripts/dev-harness/serve.mjs 4319',
        url: 'http://127.0.0.1:4319/scripts/dev-harness/',
        reuseExistingServer: true,
        timeout: 15_000,
    },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
