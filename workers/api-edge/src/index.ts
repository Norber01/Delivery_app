import { MapboxProvider } from '@courier/shared-utils';
import { handleRequest, type Env } from './handler.js';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.MAPBOX_TOKEN) return new Response('Service not configured', { status: 503 });
    return handleRequest(req, env, {
      maps: new MapboxProvider(env.MAPBOX_TOKEN),
      cache: caches.default,
      waitUntil: (p) => ctx.waitUntil(p),
    });
  },
} satisfies ExportedHandler<Env>;
