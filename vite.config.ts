import { defineConfig, type Plugin, type ViteDevServer, type HmrContext } from 'vite';
import react from '@vitejs/plugin-react';

const port = Number(process.env.PORT ?? 5224);
const devHost = process.env.THREADS_DEV_HOST ?? process.env.HOST ?? '127.0.0.1';
const publicHost = process.env.THREADS_PUBLIC_HOST ?? devHost;
const tailnetIp = process.env.THREADS_TAILNET_IP;
const tailnetDns = process.env.THREADS_TAILNET_DNS;

// HMR is disabled in favor of an explicit, user-driven full reload. file
// changes never push anything to the client; `npm run reload` posts to
// /__reload, which sends a single custom event over vite's existing
// HMR WS. the client surfaces it as a blue reload icon next to the sidebar
// settings icon; user clicks it to do a full `location.reload()`.
function explicitReloadPlugin(): Plugin {
  return {
    name: 'explicit-reload',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/__reload')) return next();
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('method not allowed');
          return;
        }
        server.ws.send({ type: 'custom', event: 'reload-available' });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, kind: 'reload-signal' }));
      });
    },
    handleHotUpdate(_ctx: HmrContext) {
      // suppress every default HMR/full-reload vite would otherwise push
      return [];
    },
  };
}

export default defineConfig({
  plugins: [react(), explicitReloadPlugin()],
  server: {
    host: devHost,
    port,
    strictPort: true,
    allowedHosts: [devHost, publicHost, tailnetIp, tailnetDns].filter(
      (host): host is string => !!host
    ),
    hmr: {
      host: publicHost,
      clientPort: port,
    },
    proxy: {
      '/api/pty': {
        target: `ws://127.0.0.1:${process.env.THREADS_API_PORT ?? '5314'}`,
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: `http://127.0.0.1:${process.env.THREADS_API_PORT ?? '5314'}`,
        changeOrigin: true,
      },
    },
  },
});
