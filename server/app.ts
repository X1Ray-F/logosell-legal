/**
 * Routing for logosell.app. Pure in the sense that matters for tests: every
 * side effect (database read, file read) arrives as a dependency, so the whole
 * router can be exercised with fakes and no network.
 *
 * Only three paths are rendered here. Everything else — the legal pages, the
 * landing page, /m/<token>, /p/<code>, /.well-known/assetlinks.json, which
 * Android must fetch for App Links to keep opening shared links in the app —
 * falls through to the static files exactly as GitHub Pages served them,
 * including 404.html for unknown paths, because 404.html carries the
 * client-side routing for the safety and Founder Card links.
 */
import {
  listingPage, sellerPage, zonePage, unavailablePage, sitemap, STYLE_SHA256,
} from './render.ts';
import {
  fetchListing, fetchSeller, fetchPublicListings,
  fetchZone, fetchZoneListings, fetchZoneCategories,
  UUID_RE, type Env,
} from './data.ts';

export interface Deps {
  env: Env;
  /** Serves a file from the static site; must answer unknown paths with
   *  404.html at status 404, the way GitHub Pages did. */
  serveStatic: (req: Request) => Promise<Response>;
  fetchListing?: typeof fetchListing;
  fetchSeller?: typeof fetchSeller;
  fetchPublicListings?: typeof fetchPublicListings;
  fetchZone?: typeof fetchZone;
  fetchZoneListings?: typeof fetchZoneListings;
  fetchZoneCategories?: typeof fetchZoneCategories;
}

function csp(env: Env): string {
  const sb = env.url ? ` ${env.url}` : '';
  return [
    "default-src 'none'",
    `style-src '${STYLE_SHA256}'`,
    `img-src 'self'${sb} data:`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function html(body: string, env: Env, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp(env),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      // Five minutes: long enough that a link going round a group chat is one
      // database read, short enough that a price change shows up the same day.
      // A page that is gone is not cached at all, so a sold item stops
      // previewing as available as soon as it sells.
      'Cache-Control': status === 200 ? 'public, max-age=300' : 'no-store',
    },
  });
}

/** The origin to build canonical URLs and links from. Taken from the request so
 *  a preview deployment links to itself rather than to production, but only for
 *  hosts we recognise — a forged Host header must not be able to plant its own
 *  domain in our canonical tag or og:url. */
export function originOf(req: Request, allowed: string[]): string {
  const u = new URL(req.url);
  // hostname, not host: the allowlist holds bare names, and u.host carries the
  // port (localhost:8000), so comparing against it rejected every local run.
  const name = u.hostname.toLowerCase();
  const ok = allowed.some((a) => name === a || name.endsWith('.' + a));
  return ok ? `${u.protocol}//${u.host}` : 'https://logosell.app';
}

export const ALLOWED_HOSTS = ['logosell.app', 'deno.dev', 'localhost', '127.0.0.1'];

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const { env } = deps;
  const getListing = deps.fetchListing ?? fetchListing;
  const getSeller = deps.fetchSeller ?? fetchSeller;
  const getPublic = deps.fetchPublicListings ?? fetchPublicListings;
  const getZone = deps.fetchZone ?? fetchZone;
  const getZoneListings = deps.fetchZoneListings ?? fetchZoneListings;
  const getZoneCategories = deps.fetchZoneCategories ?? fetchZoneCategories;

  const url = new URL(req.url);
  const path = decodeURIComponent(url.pathname);
  const origin = originOf(req, ALLOWED_HOSTS);

  const rendered = /^\/(listing|seller)\/([^/]+)\/?$/.exec(path) || path === '/sitemap.xml';
  if (rendered && req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const m = /^\/(listing|seller)\/([^/]+)\/?$/.exec(path);
  if (m) {
    const [, kind, id] = m;
    // A non-UUID is not a lookup miss, it is a malformed request: answer the
    // same unavailable page without touching the database.
    if (!UUID_RE.test(id)) return html(unavailablePage(origin), env, 404);

    if (kind === 'listing') {
      const listing = await getListing(env, id);
      if (!listing) return html(unavailablePage(origin), env, 404);
      return html(listingPage({ id, listing, origin }), env);
    }
    const found = await getSeller(env, id);
    if (!found) return html(unavailablePage(origin), env, 404);
    return html(sellerPage({ id, seller: found.seller, listings: found.listings, origin }), env);
  }

  /*
    /<zone> and /<zone>/<category>. Checked against the zone list rather than
    claimed by the pattern, so a request for /join or /anything falls through to
    the static site exactly as it did before — this route only answers for a
    place that really exists. The zone list is cached for an hour in data.ts, so
    a crawler walking 404s does not become a database round trip each time.

    A path with a dot cannot reach here (privacy.html and friends are matched by
    their own names below), and /listing, /seller and /sitemap.xml are handled
    above, so there is nothing for this to shadow.
  */
  const zoneMatch = /^\/([a-z0-9][a-z0-9-]{1,48})(?:\/([a-z0-9][a-z0-9_-]{0,48}))?\/?$/.exec(path);
  if (zoneMatch && (req.method === 'GET' || req.method === 'HEAD')) {
    const [, slug, category] = zoneMatch;
    const zone = await getZone(env, slug);
    if (zone) {
      const [listings, categories] = await Promise.all([
        getZoneListings(env, slug, category ?? null),
        getZoneCategories(env, slug),
      ]);
      const active = category ? categories.find((c) => c.id === category) ?? null : null;
      // A category named in the URL that holds nothing in this zone is not a
      // page: it is a guess by a crawler, and it must not become an indexable
      // empty page with a plausible title.
      if (category && !active) return html(unavailablePage(origin), env, 404);
      return html(
        zonePage({ zone, listings, categories, activeCategory: active, origin }), env);
    }
  }

  if (path === '/sitemap.xml') {
    const listings = await getPublic(env);
    // Only zones and zone+category pairs that actually hold something. Derived
    // from the listings we just read, so it costs no extra query.
    const zoneSet = new Set<string>();
    for (const l of listings) {
      const z = (l as { zone_slug?: string | null }).zone_slug;
      const c = (l as { category_id?: string | null }).category_id;
      if (!z) continue;
      zoneSet.add(`/${z}`);
      if (c) zoneSet.add(`/${z}/${c}`);
    }
    const zonePaths = [...zoneSet].sort();
    return new Response(sitemap({ origin, listings, zonePaths }), {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  return deps.serveStatic(req);
}
