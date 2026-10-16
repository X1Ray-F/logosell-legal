/**
 * Entry point. Everything with logic lives in app.ts / render.ts / data.ts and
 * is tested there; this file is the part that can only run on a real host.
 *
 * Local:  deno task dev
 * Deploy: Deno Deploy, this repo, entry server/main.ts (see server/RUNBOOK.md)
 */
import { serveDir } from 'jsr:@std/http@1/file-server';
import { handle, type Deps } from './app.ts';

const env = {
  url: Deno.env.get('SUPABASE_URL') ?? '',
  anon: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
};

if (!env.url || !env.anon) {
  // Not fatal: the static site must keep serving even if the keys are missing,
  // because the legal pages are a published obligation. Listing pages will
  // answer "not available" instead of rendering, which is the safe direction.
  console.warn('SUPABASE_URL / SUPABASE_ANON_KEY not set — listing pages will not render');
}

/** The static site is this repository. `server/` is source, not content. */
const serveStatic: Deps['serveStatic'] = async (req) => {
  const path = new URL(req.url).pathname;
  if (path === '/server' || path.startsWith('/server/')) {
    return notFound(req);
  }
  const res = await serveDir(req, { fsRoot: '.', quiet: true, showDirListing: false });
  if (res.status === 404) return notFound(req);
  return res;
};

/**
 * GitHub Pages answered an unknown path with 404.html at status 404, and
 * 404.html carries the client-side routing for /m/<token> (a safety link sent
 * to a friend) and /p/<code> (printed on the Founder Cards already in people's
 * hands). Serving a bare 404 here would break both.
 */
async function notFound(req: Request): Promise<Response> {
  try {
    const body = await Deno.readTextFile('./404.html');
    return new Response(body, {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

Deno.serve((req) => handle(req, { env, serveStatic }));
