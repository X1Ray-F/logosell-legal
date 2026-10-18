/**
 * Reads for the public web surface. Anon key only — the same key the app ships,
 * so this adds no reach: anything readable here is already readable by a
 * logged-out member browsing the app ("Răsfoire publică, acțiuni doar pentru
 * membri", README).
 */
import type { Listing, Seller, ShopFront } from './render.ts';

/**
 * Only a canonical UUID is ever interpolated into a PostgREST URL. This is not
 * cosmetic: PostgREST takes repeated query parameters, so an id like
 * `x&select=*` would append a second `select=` and drop the `circle_id` and
 * `status` filters below — which is exactly how a private circle listing or a
 * moderator-hidden one would be unmasked. Carried over from
 * supabase/functions/listing-page, which found this first.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Env { url: string; anon: string }

/**
 * `seller_id` is selected on its own, beside the embedded profile, because shop
 * mode is decided from it: whether a listing may show a price depends on whether
 * its seller is a verified trader, and that must not hang on an embed that can
 * come back null. It is NOT NULL in the schema, so every row has one.
 */
const LISTING_COLS =
  'id,seller_id,title,description,price_gbp,images,city,condition,created_at,category_id,zone_slug,' +
  'seller:profiles!listings_seller_id_fkey(id,handle,display_name,verified,city,rating,rating_count)';

/**
 * A listing gets a public page only if it is active, not hidden and not inside
 * a private circle. The old renderer selected `circle_id` but never `status` or
 * `hidden`, so it would happily render a sold item or one a moderator had taken
 * down — with correct Open Graph tags, to whoever the link reached.
 */
const PUBLIC_FILTERS = 'status=eq.active&hidden=is.false&circle_id=is.null';

async function rest<T>(env: Env, path: string): Promise<T | null> {
  if (!env.url || !env.anon) return null;
  try {
    const r = await fetch(`${env.url}/rest/v1/${path}`, {
      headers: {
        apikey: env.anon,
        Authorization: `Bearer ${env.anon}`,
        'Accept-Profile': 'markety',
      },
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchListing(env: Env, id: string): Promise<Listing | null> {
  if (!UUID_RE.test(id)) return null;
  const rows = await rest<Listing[]>(
    env, `listings?id=eq.${id}&${PUBLIC_FILTERS}&select=${LISTING_COLS}&limit=1`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function fetchSeller(
  env: Env, id: string,
): Promise<{ seller: Seller; listings: Listing[] } | null> {
  if (!UUID_RE.test(id)) return null;
  const profiles = await rest<Seller[]>(
    env,
    `profiles?id=eq.${id}&select=id,handle,display_name,verified,city,rating,rating_count&limit=1`);
  if (!Array.isArray(profiles) || !profiles.length) return null;
  const listings = await rest<Listing[]>(
    env,
    `listings?seller_id=eq.${id}&${PUBLIC_FILTERS}&select=${LISTING_COLS}` +
    `&order=created_at.desc&limit=40`) ?? [];
  return { seller: profiles[0], listings: Array.isArray(listings) ? listings : [] };
}

export interface Zone { slug: string; name: string }

/**
 * The zone list, cached in the worker for an hour. It is read on nearly every
 * request — to decide whether `/hounslow` is a place or a typo — and it changes
 * about never (markety.zones is a seeded table of town centres, 0145). Without
 * the cache, every 404 on the site would cost a database round trip, which is
 * exactly what a crawler would hand us.
 */
let zoneCache: { at: number; zones: Zone[] } | null = null;
const ZONE_TTL_MS = 60 * 60 * 1000;

export async function fetchZones(env: Env): Promise<Zone[]> {
  if (zoneCache && Date.now() - zoneCache.at < ZONE_TTL_MS) return zoneCache.zones;
  const rows = await rest<Zone[]>(env, 'zones?select=slug,name&order=name.asc');
  // A failed read must not poison the cache with an empty list for an hour: on
  // failure we keep whatever we had and retry on the next request.
  if (!Array.isArray(rows)) return zoneCache?.zones ?? [];
  zoneCache = { at: Date.now(), zones: rows };
  return rows;
}

export async function fetchZone(env: Env, slug: string): Promise<Zone | null> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return null;
  return (await fetchZones(env)).find((z) => z.slug === slug) ?? null;
}

export interface CategoryCount { id: string; name: string; emoji: string | null; n: number }

/**
 * Listings in a zone, newest first, optionally narrowed to one category. The
 * same PUBLIC_FILTERS as everywhere else, so a sold, hidden or private-circle
 * item can never appear on an indexable page.
 *
 * zone_slug arrives with 0145. Until that migration is applied, PostgREST
 * answers 400 for an unknown column, rest() turns that into null and the page
 * renders as an empty zone rather than an error — which is the right shape for
 * a page nobody can fill yet.
 */
export async function fetchZoneListings(
  env: Env, slug: string, category?: string | null, limit = 60,
): Promise<Listing[]> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return [];
  const cat = category && /^[a-z0-9_-]+$/.test(category)
    ? `&category_id=eq.${category}` : '';
  const rows = await rest<Listing[]>(
    env,
    `listings?zone_slug=eq.${slug}&${PUBLIC_FILTERS}${cat}` +
    `&select=${LISTING_COLS}&order=created_at.desc&limit=${limit}`);
  return Array.isArray(rows) ? rows : [];
}

/** Which categories actually have something in this zone, for the page's own
 *  links. A category with nothing in it is a page Google would index as empty. */
export async function fetchZoneCategories(
  env: Env, slug: string,
): Promise<CategoryCount[]> {
  const listings = await fetchZoneListings(env, slug, null, 200);
  const names = await rest<{ id: string; name: string; emoji: string | null }[]>(
    env, 'categories?select=id,name,emoji') ?? [];
  const byId = new Map(names.map((c) => [c.id, c]));
  const counts = new Map<string, number>();
  for (const l of listings) {
    const id = (l as unknown as { category_id?: string }).category_id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, n]) => ({ id, name: byId.get(id)?.name ?? id, emoji: byId.get(id)?.emoji ?? null, n }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/** For the sitemap. Capped: a sitemap file may hold 50,000 URLs, and we are
 *  nowhere near that, but an unbounded select is a bad habit to deploy. */
export async function fetchPublicListings(
  env: Env, limit = 5000,
): Promise<{ id: string; created_at?: string | null; zone_slug?: string | null; category_id?: string | null }[]> {
  const rows = await rest<{ id: string; created_at: string; zone_slug: string | null; category_id: string | null }[]>(
    env,
    `listings?${PUBLIC_FILTERS}&select=id,created_at,zone_slug,category_id` +
    `&order=created_at.desc&limit=${limit}`);
  return Array.isArray(rows) ? rows : [];
}

/*
  ── Shop mode: who is a verified trader ─────────────────────────────────────

  A page may show a price only for a PRIVATE seller. A verified trader gets a
  shop page with no price on it anywhere (render.ts, shopListingPage), because
  the premise of that page is that it is not an invitation to purchase. So every
  page that would print a price first has to know whether its seller is a
  trader, and "I could not find out" must never be answered with a price.

  The source of truth is markety.trader_accounts, read as a LIST of verified
  profile ids, rather than shop_front(id) asked once per seller:

    * a zone page shows listings from many sellers; with a list that is one
      cached read, with the RPC it would be one round trip per seller;
    * the answer to "is this seller a trader" is then a set lookup, so a request
      for a private seller's page costs nothing extra once the cache is warm;
    * anon may read exactly these columns (profile_id, status) of verified rows,
      and nothing about an address, so the list adds no reach (0143, 0149).

  shop_front is still used, but only to dress a shop page (name, hours): losing
  it degrades the header, never the rule.
*/

const TRADER_TTL_MS = 60 * 1000;
/** How long an old list may stand in for a fresh one while the read is failing.
 *  Bounded on purpose: a trader verified during an outage is missing from an old
 *  list and would get a price page, so the list may only be trusted so long. */
const TRADER_STALE_MS = 15 * 60 * 1000;
const TRADER_PAGE = 1000;
const TRADER_MAX_PAGES = 200;

let traderCache: { at: number; ids: ReadonlySet<string> } | null = null;
let traderInflight: Promise<ReadonlySet<string> | null> | null = null;
let traderWarnedAt = 0;

/** For tests: forget everything this module remembers about traders. */
export function resetTraderCache(): void {
  traderCache = null;
  traderInflight = null;
  traderWarnedAt = 0;
}

/**
 * Every verified trader's profile id, paged by keyset until a page comes back
 * EMPTY. Not "until a page is short": PostgREST silently truncates a response
 * to the project's max-rows (1000 by default, configurable), so a short page
 * proves nothing, and a list that quietly lost its tail would hand a price page
 * to exactly the traders at the end of it. Any row that is not a canonical UUID,
 * or a page that fails to advance, fails the whole read.
 */
async function readTraderIds(env: Env): Promise<Set<string> | null> {
  const ids = new Set<string>();
  let after = '';
  for (let page = 0; page < TRADER_MAX_PAGES; page++) {
    const rows = await rest<{ profile_id?: unknown }[]>(
      env,
      `trader_accounts?select=profile_id&status=eq.verified&order=profile_id.asc` +
      `&limit=${TRADER_PAGE}${after ? `&profile_id=gt.${after}` : ''}`);
    if (!Array.isArray(rows)) return null;
    if (rows.length === 0) return ids;
    let last = '';
    for (const r of rows) {
      const id = typeof r?.profile_id === 'string' ? r.profile_id.toLowerCase() : '';
      if (!UUID_RE.test(id)) return null;
      ids.add(id);
      last = id;
    }
    // Ascending order means the last row is the largest. If it did not move, the
    // server ignored the cursor and we would loop on the same page.
    if (last <= after) return null;
    after = last;
  }
  // More pages than any real deployment: a partial list is worse than none.
  return null;
}

/**
 * The set of verified-trader profile ids, or null when it cannot be established
 * — which callers must treat as "every seller might be a trader".
 *
 * Fresh for a minute. If a refresh fails, the previous list is used for up to
 * fifteen minutes and then dropped, so a broken read shows up as 404s instead of
 * a slowly staler list. Concurrent callers share one refresh.
 */
export function fetchTraderIds(
  env: Env, now = Date.now(),
): Promise<ReadonlySet<string> | null> {
  if (traderCache && now - traderCache.at < TRADER_TTL_MS) {
    return Promise.resolve(traderCache.ids);
  }
  if (!traderInflight) {
    traderInflight = readTraderIds(env)
      .then((ids) => {
        if (ids) {
          traderCache = { at: now, ids };
          return ids;
        }
        if (traderCache && now - traderCache.at < TRADER_STALE_MS) return traderCache.ids;
        // Said once a minute, not once a request: when this fires every page
        // that would show a price answers 404, and "the site is down" is the
        // wrong conclusion to leave someone to draw.
        if (env.url && env.anon && now - traderWarnedAt > TRADER_TTL_MS) {
          traderWarnedAt = now;
          console.warn(
            'verified-trader list unreadable and no recent copy: pages that would show a ' +
            'price answer 404 until it can be read (see server/RUNBOOK.md, shop mode)');
        }
        return null;
      })
      .finally(() => { traderInflight = null; });
  }
  return traderInflight;
}

/**
 * The shop front for one verified trader, reduced to the fields a page may use.
 * markety.shop_front also returns a company number, exact-ish coordinates, a
 * rating and a review count; none of them is copied out here, so none of them
 * can reach a page. `[]` means the RPC says this is not a verified trader (a
 * race with a status change) and a failed call is null too: both degrade the
 * header and neither changes what the page is allowed to show.
 */
export async function fetchShop(env: Env, id: string): Promise<ShopFront | null> {
  if (!UUID_RE.test(id)) return null;
  const rows = await rest<Record<string, unknown>[]>(env, `rpc/shop_front?p_trader=${id}`);
  const r = Array.isArray(rows) ? rows[0] : null;
  if (!r || typeof r !== 'object') return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    business_name: text(r.business_name),
    display_name: text(r.display_name),
    city: text(r.city),
    hours_today: r.hours_today,
    open_now: typeof r.open_now === 'boolean' ? r.open_now : null,
    listings_live: typeof r.listings_live === 'number' ? r.listings_live : null,
  };
}
