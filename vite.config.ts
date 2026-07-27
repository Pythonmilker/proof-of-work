import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * The dev server doubles as the pipeline's HTTP surface.
 *
 * Why bother: the OpenRouter key must not reach the browser bundle. Running the pipeline behind
 * `/api/*` keeps it in the Node process, which is also the shape n8n exposes (webhook in, JSON out) —
 * so the React app talks to one contract and neither knows nor cares which side is answering.
 *
 * With no key set, the browser runs the very same pipeline module client-side on the deterministic
 * path, so `pnpm build` produces a static site that still works end to end. See src/pipeline/README.
 */
function pipelineApi(env: Record<string, string>): Plugin {
  return {
    name: 'proof-of-work-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();

        const respond = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };

        try {
          // Imported lazily and through Vite's module graph so edits hot-reload without a restart.
          const api = (await server.ssrLoadModule('/src/server/handlers.ts')) as {
            handle: (path: string, body: unknown, env: Record<string, string>) => Promise<unknown>;
          };

          // Reads are GETs so they can be opened in a browser tab while debugging; everything that
          // changes state is a POST.
          if (req.method === 'GET') {
            if (req.url === '/api/health' || req.url === '/api/snapshot') {
              return respond(200, await api.handle(req.url, null, env));
            }
            return respond(404, { error: `unknown endpoint: ${req.url}` });
          }
          if (req.method !== 'POST') return respond(405, { error: 'method not allowed' });

          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const raw = Buffer.concat(chunks).toString('utf8');
          const body: unknown = raw ? JSON.parse(raw) : null;

          return respond(200, await api.handle(req.url, body, env));
        } catch (err) {
          // Deliberately verbose: a silent 500 during a demo is the failure mode this repo argues against.
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[api] ${req.url} failed: ${message}`);
          return respond(500, { error: message });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Server-only secrets: loaded with no prefix filter, and never handed to `define`.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react(), pipelineApi(env)],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { port: 5273, strictPort: false },
    build: { outDir: 'dist', sourcemap: true },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  };
});
