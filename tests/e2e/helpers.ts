import type { Page } from '@playwright/test';

export async function blockOptionalThirdPartyAssets(page: Page): Promise<void> {
  await page.route(
    /https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|challenges\.cloudflare\.com)\/.*/,
    (route) => route.abort()
  );
  // 全局基础 API 兜底拦截：
  // 确保前端启动与登录初始化自发发出的公共探测请求（基础安全配置、移动端快捷键云端同步等）在浏览器内核层即时返回，
  // 避免未在具体测试中 mock 的请求穿透至无 8787 后端的 Vite 代理并触发 ECONNREFUSED。
  // Playwright 遵循后注册优先原则，具体测试用例若有特殊配置（如启用 Turnstile 或定制快捷键）再次注册即可覆盖默认值。
  await page.route('**/api/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        turnstileEnabled: false,
        sitekey: '',
        githubAuthEnabled: false,
        githubAuthRequired: false,
      }),
    })
  );
  await page.route('**/api/user/mobile-shortcuts', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ shortcuts: null }),
    })
  );
}

export async function mockAnonymousSession(page: Page): Promise<void> {
  await blockOptionalThirdPartyAssets(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"unauthorized"}',
    })
  );
}
