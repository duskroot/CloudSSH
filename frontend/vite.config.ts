import { defineConfig } from 'vite';

export default defineConfig({
  // @xterm/xterm 6 ships pre-minified ESM. Re-running esbuild's syntax
  // minifier can drop a declaration in InputHandler.requestMode, causing
  // DECRQM queries from Vim and other TUIs to throw and stop terminal input.
  // Keep the other minification passes enabled while avoiding that transform.
  // https://github.com/xtermjs/xterm.js/issues/5800
  esbuild: {
    minifySyntax: false,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        ws: true,
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            // E2E 测试或独立前端调试未启动 8787 后端时平稳降级，避免 AggregateError [ECONNREFUSED] 刷屏
            const socketOrRes = res as any;
            if (socketOrRes && !socketOrRes.headersSent && typeof socketOrRes.writeHead === 'function') {
              socketOrRes.writeHead(502, { 'Content-Type': 'application/json' });
              socketOrRes.end(JSON.stringify({ error: 'Backend unreachable (localhost:8787)' }));
            }
          });
        },
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
});
