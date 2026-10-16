/**
 * Reads for the public web surface. Anon key only — the same key the app ships,
 * so this adds no reach: anything readable here is already readable by a
 * logged-out member browsing the app ("Răsfoire publică, acțiuni doar pentru
 * membri", README).
 */
import type { Listing, Seller } from './render.ts';

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

const LISTING_COLS =
  'id,title,description,price_gbp,images,city,condition,created_at,category_id,zone_slug,' +
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
