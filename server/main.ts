/**
 * Entry point. Everything with logic lives in app.ts / render.ts / data.ts and
 * is tested there; this file is the part that can only run on a real host.
 *
 * Local:  deno task dev
 * Deploy: Deno Deploy, this repo, entry server/main.ts (see server/RUNBOOK.md)
 */
import { serveDir } from 'jsr:@std/http@1/file-server';
import { canonicalPath, type Deps, handle, isSourcePath } from './app.ts';

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

/** The static site is this repository. `server/` is source, not content.
 *
 *  The path is settled by canonicalPath first, because this guard used to read
 *  the raw pathname and /server%2fapp.ts walked straight past it into the file
 *  server, which decodes before it looks on disk (app.ts, canonicalPath). */
const serveStatic: Deps['serveStatic'] = async (req) => {
  const path = canonicalPath(new URL(req.url).pathname);
  if (path === null || isSourcePath(path)) {
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
      // Short rather than no-store: this answer needs no database, so letting a
      // cache hold it for a minute only saves work, and the 404.html client-side
      // routing does not depend on it being fresh.
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// Localhost and 127.0.0.1 may name themselves only when asked to, which
// `deno task dev` does. On Deploy the variable is not set.
const dev = Deno.env.get('LOGOSELL_DEV') === '1';

// One Deps object for the life of the process: handle() keeps its page cache
// per Deps, so building a new one for every request would defeat it.
const deps: Deps = { env, serveStatic, dev };

Deno.serve((req) => handle(req, deps));
