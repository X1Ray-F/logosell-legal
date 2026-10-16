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
  'id,title,description,price_gbp,images,city,condition,created_at,' +
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

/** For the sitemap. Capped: a sitemap file may hold 50,000 URLs, and we are
 *  nowhere near that, but an unbounded select is a bad habit to deploy. */
export async function fetchPublicListings(
  env: Env, limit = 5000,
): Promise<{ id: string; created_at?: string | null }[]> {
  const rows = await rest<{ id: string; created_at: string }[]>(
    env, `listings?${PUBLIC_FILTERS}&select=id,created_at&order=created_at.desc&limit=${limit}`);
  return Array.isArray(rows) ? rows : [];
}
