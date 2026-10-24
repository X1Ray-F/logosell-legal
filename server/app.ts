/**
 * Routing for logosell.app. Pure in the sense that matters for tests: every
 * side effect (database read, file read) arrives as a dependency, so the whole
 * router can be exercised with fakes and no network.
 *
 * Rendered here: /listing/<id>, /seller/<id>, the zone pages and /sitemap.xml.
 * Answered here without touching the static handler: /.well-known/* (see below)
 * and /s.html (see below). Everything else — the legal pages, the landing page,
 * /m/<token>, /p/<code> — falls through to the static files exactly as GitHub
 * Pages served them, including 404.html for unknown paths, because 404.html
 * carries the client-side routing for the safety and Founder Card links.
 *
 * SHOP MODE. A seller who is a verified trader (markety.trader_accounts.status =
 * 'verified') gets pages with no price anywhere: a page without a price is
 * probably not an "invitation to purchase" (DMCC Act 2024 s.230(10), CMA207
 * 4.11). Every route that could print a price therefore asks one question
 * first, "is this seller a verified trader?", and if the answer cannot be
 * established it does not render: 404, no-store. Never a price page for a seller
 * whose trader status is unknown.
 */
import {
  listingPage, sellerPage, zonePage, unavailablePage, sitemap, STYLE_SHA256,
  shopListingPage, shopSellerPage, sellerIdOf,
} from './render.ts';
import {
  fetchListing, fetchSeller, fetchPublicListings,
  fetchZone, fetchZoneListings, fetchZoneCategories, fetchCategories,
  fetchTraderIds, fetchShop,
  UUID_RE, type Env,
} from './data.ts';
import { WELL_KNOWN } from './wellknown.ts';

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
  /** The category list (cached an hour in data.ts). null = unreadable, which
   *  means "unknown", never "there are none". */
  fetchCategories?: typeof fetchCategories;
  /** Also let localhost and 127.0.0.1 name themselves. Off in production: set
   *  only by `deno task dev` (LOGOSELL_DEV=1), see main.ts. */
  dev?: boolean;
  /** Clock for the page cache; tests move it. */
  now?: () => number;
  /** The verified traders. null = could not be read and nothing recent is cached;
   *  every route that prints a price then refuses to render. */
  fetchTraders?: typeof fetchTraderIds;
  fetchShop?: typeof fetchShop;
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

/** How long a shop page may be cached. Shorter than a person-to-person page
 *  because a shop page is the one that has to give way when a seller's trader
 *  status changes, and a cached page cannot be told. */
const SHOP_MAX_AGE = 60;

/** How long an answer of "there is no such page" may be cached. Short: long
 *  enough that a link someone keeps pasting is not a fresh round trip every
 *  time, short enough that a page which appears later is not hidden for long. */
const NOT_FOUND_MAX_AGE = 60;

/** How long a rendered zone page or the sitemap is kept in this process. It
 *  absorbs a crawler or a link going round, so the same page is not rebuilt from
 *  three database reads on every request. */
const PAGE_TTL_MS = 45 * 1000;

function html(
  body: string, env: Env, status = 200, maxAge = 300, cacheable404 = false,
): Response {
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
      // cacheable404 is only for a 404 that is a settled fact about the URL
      // (a slug that is not a category). A refusal that comes from a failed
      // read, such as the trader list, stays no-store: caching it would stretch
      // an outage by the cache's lifetime.
      'Cache-Control': status === 200 ? `public, max-age=${maxAge}`
        : cacheable404 ? `public, max-age=${NOT_FOUND_MAX_AGE}` : 'no-store',
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
  // Exact match only. A suffix match let anything under an allowed domain (any
  // x.deno.dev) become the canonical and sitemap origin of this site.
  const ok = allowed.includes(name);
  return ok ? `${u.protocol}//${u.host}` : 'https://logosell.app';
}

/**
 * Hosts whose own name may appear in canonical, og:url, links and the sitemap:
 * the site itself, and the one Deploy host this app runs on (RUNBOOK.md). Exact
 * names, nothing matched by suffix. This list used to hold `deno.dev` and
 * `localhost`, so a request for any x.deno.dev could plant its own host in every
 * canonical tag and in the sitemap. A preview deployment on another host links
 * back to production, which is the safe direction. app_test.ts reads the
 * production host out of RUNBOOK.md and fails if it stops being covered.
 */
export const ALLOWED_HOSTS = [
  'logosell.app', 'www.logosell.app', 'logosell-web.x1ray-f.deno.net',
];

/** Added to ALLOWED_HOSTS only when Deps.dev is set, so a local run links to
 *  itself while production never trusts a Host header of "localhost". */
export const DEV_HOSTS = ['localhost', '127.0.0.1'];

/** The hosts search engines may index. Anything else serving this site (the
 *  *.deno.net host) is a duplicate of it, and the static legal pages there have
 *  no canonical tag. */
const INDEXABLE_HOSTS = ['logosell.app', 'www.logosell.app'];

/**
 * The path a request is really asking for, or null when it cannot be one.
 *
 * `new URL(req.url).pathname` keeps the escapes exactly as they were sent,
 * while the file server decodes them before it looks on disk. Every rule that
 * compared the raw spelling therefore guarded one spelling and missed the
 * other. Measured on the live host on 2026-10-18, not reasoned about:
 *
 *     /server/app.ts     -> 404            (the guard in main.ts)
 *     /server%2fapp.ts   -> 200, 7192 B    (the TypeScript source)
 *     /%73erver/app.ts   -> 200, 7192 B    (the same file, 's' escaped)
 *     /s.html%2f?t=…     -> 200, 7010 B    (s.html, which prints the price)
 *
 * So the path is settled once, here, and every rule below compares against
 * this one form: decode once — the same single decode the file server does —
 * then drop empty segments and the trailing slash.
 *
 * A path still carrying a '%' after that decode was encoded twice. Nothing in
 * this repository is named with one, so it can never match a file; the same
 * holds for a dot segment, which the file server refuses anyway. Both return
 * null rather than a cleaned-up guess, because a guess is how the first two
 * lines above happened.
 */
export function canonicalPath(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // a malformed escape, e.g. /%zz — decodeURIComponent throws
  }
  if (decoded.includes('%') || decoded.includes('\0')) return null;
  const parts = decoded.split('/').filter((p) => p !== '');
  if (parts.some((p) => p === '.' || p === '..')) return null;
  return '/' + parts.join('/');
}

/** `server/` is this application's source, not the site's content. The static
 *  root is the repository itself, so without this the server hands out its own
 *  TypeScript — and the repository is private. Takes a path from
 *  canonicalPath, never a raw one. */
export function isSourcePath(path: string): boolean {
  const p = path.toLowerCase();
  return p === '/server' || p.startsWith('/server/') || REPO_ONLY.has(p);
}

/** Files at the repository root that are tooling or hosting leftovers, not part
 *  of the site: the Deno config and lockfile, and GitHub Pages' CNAME. */
const REPO_ONLY = new Set(['/deno.json', '/deno.lock', '/cname']);

/**
 * Headers every static file gets, whatever it is. frame-ancestors only works as
 * a header (a <meta> CSP ignores it), so this is the only way m.html and the
 * other pages can refuse to be framed. It is a second policy beside each page's
 * own <meta> one: a browser enforces both.
 */
const STATIC_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

/** Response headers from fetch() or a file server can be immutable, so a
 *  response that needs changing is rebuilt around the same body. */
function withHeaders(res: Response, set: Record<string, string>, onlyMissing = false): Response {
  const todo = Object.entries(set).filter(([k]) => !(onlyMissing && res.headers.has(k)));
  if (todo.length === 0) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of todo) out.headers.set(k, v);
  return out;
}

/** Every answer on a host that is not the public site is marked noindex. */
function finish(req: Request, res: Response): Response {
  const host = new URL(req.url).hostname.toLowerCase();
  return INDEXABLE_HOSTS.includes(host) ? res : withHeaders(res, { 'X-Robots-Tag': 'noindex' });
}

/** Stores a page, and drops everything stale first so the map cannot grow
 *  without bound: the key includes the request path, which a crawler controls
 *  (only paths that passed the zone and category checks reach here, but that is
 *  still zones x categories x origins). */
function remember(pages: Map<string, CachedPage>, key: string, page: CachedPage): void {
  for (const [k, v] of pages) if (page.at - v.at >= PAGE_TTL_MS) pages.delete(k);
  if (pages.size >= 500) pages.clear();
  pages.set(key, page);
}

/** Rendered pages kept for PAGE_TTL_MS, per Deps object so that tests with
 *  different fakes never see each other's pages. */
type CachedPage = { at: number; status: number; body: string };
const pageCaches = new WeakMap<Deps, Map<string, CachedPage>>();

export async function handle(req: Request, deps: Deps): Promise<Response> {
  return finish(req, await route(req, deps));
}

async function route(req: Request, deps: Deps): Promise<Response> {
  const { env } = deps;
  const serveStatic = async (r: Request) =>
    withHeaders(await deps.serveStatic(r), STATIC_HEADERS, true);
  const now = deps.now ?? Date.now;
  const pages = pageCaches.get(deps) ?? new Map<string, CachedPage>();
  pageCaches.set(deps, pages);
  const getCategories = deps.fetchCategories ?? fetchCategories;
  const getListing = deps.fetchListing ?? fetchListing;
  const getSeller = deps.fetchSeller ?? fetchSeller;
  const getPublic = deps.fetchPublicListings ?? fetchPublicListings;
  const getZone = deps.fetchZone ?? fetchZone;
  const getZoneListings = deps.fetchZoneListings ?? fetchZoneListings;
  const getZoneCategories = deps.fetchZoneCategories ?? fetchZoneCategories;
  // Both reads are written never to throw. The promise that matters, "no verdict,
  // no price", should not hang on that, so a throw is handled as a failed read.
  const traderReader = deps.fetchTraders ?? fetchTraderIds;
  const shopReader = deps.fetchShop ?? fetchShop;
  const getTraders = () =>
    Promise.resolve().then(() => traderReader(env)).catch(() => null);
  const getShop = (id: string) =>
    Promise.resolve().then(() => shopReader(env, id)).catch(() => null);

  const url = new URL(req.url);
  const path = canonicalPath(url.pathname);
  // Not a path any rule below can match. The static handler answers it the way
  // it answers any unknown path, with 404.html.
  if (path === null) return serveStatic(req);
  const origin = originOf(req, deps.dev ? [...ALLOWED_HOSTS, ...DEV_HOSTS] : ALLOWED_HOSTS);
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  /*
    /.well-known/*, answered from a table compiled into the server (wellknown.ts,
    generated from the .well-known/ directory by `deno task wellknown`).

    This has to be here, ahead of the static handler, because serveDir refuses
    every path with a dot segment: /.well-known/assetlinks.json was a 404 on this
    server while it was a 200 on GitHub Pages. Android checks that file to decide
    whether logosell.app/listing/... opens in the app, so a host that 404s it
    quietly turns every shared link back into a browser tab. An allowlist of exact
    paths, rather than showDotfiles: true, because the latter would also serve
    .git/.
  */
  if (Object.hasOwn(WELL_KNOWN, path)) {
    if (!isRead) {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const { type, body } = WELL_KNOWN[path];
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': type,
        // GitHub Pages sent max-age=600 for these; same here.
        'Cache-Control': 'public, max-age=600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  /*
    /s.html is the page that renders a listing or a seller IN THE BROWSER, reading
    the price (and a seller's rating and sales count) straight from the database
    with the public key. It exists for the days when this site was GitHub Pages
    and could not render anything itself, and 404.html still sends people there.
    Served as-is it would show a verified trader's price to anyone who types the
    URL, whatever this server renders at /listing/<id>.

    So it is never served: a request it would have understood is sent to the
    server-rendered page, where shop mode applies. The two patterns below are
    copied from s.html on purpose, so anything s.html could parse is redirected
    and nothing is left for it to display. A request it could not parse falls
    through to the file, which shows "not available" without reading anything.
  */
  if (path === '/s.html' && isRead) {
    const kind = (url.search.match(/[?&]t=(listing|seller)(?:&|$)/) || [])[1];
    const id = (url.search.match(/[?&]id=([0-9a-fA-F-]{36})(?:&|$)/) || [])[1];
    if (kind && id) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/${kind}/${id.toLowerCase()}`,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      });
    }
  }

  const rendered = /^\/(listing|seller)\/([^/]+)\/?$/.exec(path) || path === '/sitemap.xml';
  if (rendered && !isRead) {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const m = /^\/(listing|seller)\/([^/]+)\/?$/.exec(path);
  if (m) {
    const [, kind, id] = m;
    // A non-UUID is not a lookup miss, it is a malformed request: answer the
    // same unavailable page without touching the database.
    if (!UUID_RE.test(id)) return html(unavailablePage(origin), env, 404);
    // The trader set holds ids the way the database prints them, lower case. UUID_RE
    // accepts upper case, so the lookup key is lower-cased: otherwise
    // /seller/<ID IN CAPITALS> would not be found in the set and a trader would
    // get a price page.
    const key = id.toLowerCase();

    if (kind === 'listing') {
      const [listing, traders] = await Promise.all([getListing(env, id), getTraders()]);
      if (!listing) return html(unavailablePage(origin), env, 404);
      // Shop mode, fail closed: no trader list, or a listing that does not say
      // whose it is, and the price is not shown, nor the listing.
      const sellerId = sellerIdOf(listing);
      if (!traders || !sellerId) return html(unavailablePage(origin), env, 404);
      if (traders.has(sellerId)) {
        const shop = await getShop(sellerId);
        return html(shopListingPage({ id: key, listing, origin, shop }), env, 200, SHOP_MAX_AGE);
      }
      return html(listingPage({ id, listing, origin }), env);
    }
    const [found, traders] = await Promise.all([getSeller(env, id), getTraders()]);
    if (!found) return html(unavailablePage(origin), env, 404);
    if (!traders) return html(unavailablePage(origin), env, 404);
    if (traders.has(key)) {
      const shop = await getShop(key);
      return html(
        shopSellerPage({ id: key, seller: found.seller, listings: found.listings, origin, shop }),
        env, 200, SHOP_MAX_AGE);
    }
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
  if (zoneMatch && isRead) {
    const [, slug, category] = zoneMatch;
    const zone = await getZone(env, slug);
    if (zone) {
      // A made-up category under a real zone is refused here, against the cached
      // category list, before any listing is read. Only a list that was really
      // read can refuse: null (unreadable, nothing cached) means "don't know".
      if (category) {
        const known = await getCategories(env).catch(() => null);
        if (known && !known.some((c) => c.id === category)) {
          return html(unavailablePage(origin), env, 404, 0, true);
        }
      }
      // The built page is kept for a short while, keyed by origin as well as
      // path because the links inside it carry the origin.
      const key = `${origin}${path}`;
      const hit = pages.get(key);
      if (hit && now() - hit.at < PAGE_TTL_MS) {
        return html(hit.body, env, hit.status, 300, true);
      }
      const [listings, categories, traders] = await Promise.all([
        getZoneListings(env, slug, category ?? null),
        getZoneCategories(env, slug),
        getTraders(),
      ]);
      const active = category ? categories.find((c) => c.id === category) ?? null : null;
      // A category named in the URL that holds nothing in this zone is not a
      // page: it is a guess by a crawler, and it must not become an indexable
      // empty page with a plausible title.
      if (category && !active) {
        const body = unavailablePage(origin);
        remember(pages, key, { at: now(), status: 404, body });
        return html(body, env, 404, 0, true);
      }
      // Shop mode, fail closed: a page with listings on it needs to know which
      // sellers are traders. A page with none prints no price, so it can go out
      // even while the trader list is unreadable. Not remembered: it is a
      // failed read, and the next request should try again.
      if (!traders && listings.length > 0) return html(unavailablePage(origin), env, 404);
      const body = zonePage({
        zone, listings, categories, activeCategory: active, origin,
        traders: traders ?? undefined,
      });
      remember(pages, key, { at: now(), status: 200, body });
      return html(body, env);
    }
  }

  if (path === '/sitemap.xml') {
    const key = `${origin}${path}`;
    const hit = pages.get(key);
    let xml: string;
    if (hit && now() - hit.at < PAGE_TTL_MS) {
      xml = hit.body;
    } else {
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
      xml = sitemap({ origin, listings, zonePaths });
      remember(pages, key, { at: now(), status: 200, body: xml });
    }
    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  return serveStatic(req);
}
