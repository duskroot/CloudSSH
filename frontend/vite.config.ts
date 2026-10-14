import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const isE2E = process.env.E2E_TEST === 'true' || mode === 'test';

  return {
    // @xterm/xterm 6 ships pre-minified ESM. Re-running esbuild's syntax
    // minifier can drop a declaration in InputHandler.requestMode, causing
    // DECRQM queries from Vim and other TUIs to throw and stop terminal input.
    // Keep the other minification passes enabled while avoiding that transform.
    // https://github.com/xtermjs/xterm.js/issues/5800
    esbuild: {
      minifySyntax: false,
    },
    server: {
      // 本地全栈开发 (pnpm dev) 时代理到 8787 (wrangler dev)。
      // E2E 测试运行期间所有 API 均由 Playwright page.route() 在浏览器内核层拦截，不启动 8787 后端，
      // 禁用代理以避免未 mock 的非关键探测请求触发 ECONNREFUSED 堆栈报错刷屏。
      proxy: isE2E
        ? undefined
        : {
            '/api': {
              target: 'http://localhost:8787',
              ws: true,
            },
          },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      modulePreload: {
        polyfill: false,
      },
    },
  };
});
