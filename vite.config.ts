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
/** `DELETE /api/candidates/<id>` — the one route with an id in the path, allowlisted by this prefix. */
const CANDIDATE_PREFIX = '/api/candidates/';

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
          // changes state is a POST, except removing an applicant, which is a DELETE on that
          // applicant's own URL.
          if (req.method === 'GET') {
            const reads = ['/api/health', '/api/snapshot', '/api/candidates', '/api/pipeline/health'];
            if (reads.includes(req.url)) {
              return respond(200, await api.handle(req.url, null, env));
            }
            return respond(404, { error: `unknown endpoint: ${req.url}` });
          }

          // The one DELETE. The id travels in the path so the route reads as a resource, and the
          // handler keeps its exact-match switch: the id is handed over in the body.
          if (req.method === 'DELETE') {
            const id = req.url.startsWith(CANDIDATE_PREFIX) ? req.url.slice(CANDIDATE_PREFIX.length) : '';
            if (!id || id.includes('/')) return respond(404, { error: `unknown endpoint: ${req.url}` });
            return respond(
              200,
              await api.handle('/api/candidates/delete', { candidateId: decodeURIComponent(id) }, env),
            );
          }

          if (req.method !== 'POST') return respond(405, { error: 'method not allowed' });
          // A DELETE-only route must not be reachable by POST — otherwise the method is decoration and
          // the handler's delete case has a second, unguarded door.
          if (req.url.startsWith(CANDIDATE_PREFIX)) return respond(405, { error: 'method not allowed' });

          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const raw = Buffer.concat(chunks).toString('utf8');
          const body: unknown = raw ? JSON.parse(raw) : null;

          return respond(200, await api.handle(req.url, body, env));
        } catch (err) {
          // Deliberately verbose: a silent 500 during a demo is the failure mode this repo argues against.
          // `status` is duck-typed off the error because handlers.ts is loaded through Vite's module
          // graph — its HttpError class is not the same object identity an import here would see.
          const message = err instanceof Error ? err.message : String(err);
          const thrown = err as { status?: unknown };
          const status = typeof thrown.status === 'number' ? thrown.status : 500;
          server.config.logger.error(`[api] ${req.url} failed: ${message}`);
          return respond(status, { error: message });
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
    // Sourcemaps off for the shipped build. They embed the full original source — 1.4 MB of it — at a
    // public URL, which contradicts the boundary this product claims (DESIGN.md §v3.7: the client
    // carries nothing worth reading). They held no secrets, only env-var NAMES in code and comments,
    // but publishing the entire codebase to anyone who opens devtools is not what "self-contained
    // client with nothing exploitable in it" means. Local builds can flip this back when debugging.
    build: { outDir: 'dist', sourcemap: false },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  };
});
