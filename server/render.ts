/**
 * Pure renderers for the public web surface. No I/O, no Deno APIs — every
 * function here takes data and returns a string, so it can be tested without a
 * network or a server.
 *
 * WHY THIS EXISTS. A shared listing link used to reach GitHub Pages, which has
 * no server: /listing/<id> fell through to 404.html, and 404.html carries the
 * site-wide Open Graph tags. Measured on 2026-10-16:
 *
 *   curl -A "WhatsApp/2.23.20.0" https://logosell.app/listing/<uuid>
 *   → HTTP 404, og:title "Logosell — buy and sell nearby", generic image
 *
 * So every listing ever shared previewed identically, with no title, price or
 * photo, and returned 404 to crawlers. supabase/functions/listing-page in the
 * app repo renders the right page, but Supabase rewrites text/html served from
 * functions/v1 into text/plain with a sandbox CSP (anti-phishing on their
 * shared domain), so a browser is shown the source instead of the page. Both
 * halves existed and could not be joined. This module is the half that can be
 * served from a host we control.
 */

import { createHash } from 'node:crypto';

export interface Seller {
  id?: string;
  handle?: string | null;
  display_name?: string | null;
  verified?: boolean | null;
  city?: string | null;
  sales_count?: number | null;
  rating?: number | null;
  rating_count?: number | null;
}

export interface Zone { slug: string; name: string }
export interface CategoryCount { id: string; name: string; emoji: string | null; n: number }

export interface Listing {
  id: string;
  /** Whose listing it is. Shop mode is decided from this, so data.ts selects it
   *  on every read; optional only because older fixtures never carried it. */
  seller_id?: string | null;
  title: string;
  description?: string | null;
  price_gbp: number;
  images?: string[] | null;
  city?: string | null;
  condition?: string | null;
  created_at?: string | null;
  category_id?: string | null;
  zone_slug?: string | null;
  seller?: Seller | null;
}

/**
 * What a shop page may know about a shop. A whitelist, narrower than the
 * markety.shop_front row on purpose: the address, the coordinates, the rating
 * and review count, the company number and the collection note are not in this
 * type, so a renderer written against it cannot print them by accident, and
 * data.ts copies only these fields out of the RPC row.
 */
export interface ShopFront {
  business_name?: string | null;
  display_name?: string | null;
  city?: string | null;
  /** null or absent = the shop never set hours; [] = closed all day today;
   *  otherwise [["09:00","17:30"], ...]. Treated as untrusted input. */
  hours_today?: unknown;
  open_now?: boolean | null;
  listings_live?: number | null;
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function gbp(n: unknown): string {
  const v = Number(n ?? 0);
  return '£' + (Number.isFinite(v) ? v : 0).toLocaleString('en-GB');
}

/** First image only, and only if it is an https URL we expect. An attacker who
 *  got a `javascript:` or `data:` string into images[] would otherwise have it
 *  echoed into og:image and an <img src>. */
export function safeImage(images?: string[] | null): string {
  const first = (images && images[0]) || '';
  return /^https:\/\/[^\s"'<>]+$/.test(first) ? first : '';
}

/** Turn a slug back into something printable, for the one place a listing page
 *  has the slug but not the zone row. "waltham-forest" -> "Waltham Forest". */
export function zoneName(slug: string): string {
  return slug.split('-')
    .map((w) => (w === 'and' || w === 'upon' || w === 'of' ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

const CONDITION_LABEL: Record<string, string> = {
  new: 'New', like_new: 'Like new', good: 'Good', fair: 'Fair',
};

/** Schema.org condition URLs, so a Google result can show "Used" or "New". */
const CONDITION_SCHEMA: Record<string, string> = {
  new: 'https://schema.org/NewCondition',
  like_new: 'https://schema.org/UsedCondition',
  good: 'https://schema.org/UsedCondition',
  fair: 'https://schema.org/UsedCondition',
};

export const CSS = `:root{--ink:#16140F;--accent:#1C5B4E;--bg:#F7F5F0;--surface:#fff;--line:#E5E1D8;--muted:#8C877C}
*{box-sizing:border-box}
body{margin:0;font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:520px;margin:0 auto;padding:20px}
.brand{display:flex;align-items:center;gap:8px;font-weight:800;color:var(--accent);font-size:20px;padding:8px 0;text-decoration:none}
.card{background:var(--surface);border:1px solid var(--line);border-radius:18px;overflow:hidden}
.img{width:100%;aspect-ratio:1;object-fit:cover;background:#eee;display:block}
.body{padding:18px}
h1{font-size:22px;margin:0;line-height:1.25}
.price{font-size:30px;font-weight:800;margin:4px 0 8px}
.badge{display:inline-block;background:#E3EEE9;color:var(--accent);border-radius:999px;padding:4px 10px;font-size:13px;font-weight:600;margin:0 6px 6px 0}
.cta{display:block;text-align:center;background:var(--accent);color:#fff;text-decoration:none;font-weight:700;padding:16px;border-radius:14px;margin-top:16px}
.cta2{display:block;text-align:center;color:var(--accent);text-decoration:none;font-weight:600;padding:12px;font-size:14px}
.muted{color:var(--muted);font-size:14px}
.note{text-align:center;margin-top:18px}
.row{display:flex;gap:12px;align-items:center;padding:12px 0;border-top:1px solid var(--line);text-decoration:none;color:inherit}
.row:first-of-type{border-top:0}
.thumb{width:64px;height:64px;border-radius:12px;object-fit:cover;background:#eee;flex:0 0 auto}
.grow{min-width:0;flex:1}
.ttl{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Classes in place of inline styles, which the CSP blocks: only this hashed block is allowed. */
.nolink{text-decoration:none}
.gap{margin-top:12px}
.chips{margin:12px 0}
@media(prefers-color-scheme:dark){
  :root{--ink:#e8efec;--bg:#0e1613;--surface:#131d1a;--line:#25332e;--muted:#93a29c}
  .badge{background:#1b2d27;color:#8fe0bf}}`;

/**
 * CSP hash of the one <style> block every page carries. The static pages in
 * this repo already pin their styles by sha256 rather than allowing
 * unsafe-inline; a rendered page can do the same, because the CSS is a
 * constant. Computed once at module load.
 */
export const STYLE_SHA256 = 'sha256-' +
  createHash('sha256').update(CSS, 'utf8').digest('base64');

/** Every page gets the same head: charset, viewport, icons, theme, CSS. */
function head(title: string, extra: string): string {
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="any">
<meta name="theme-color" content="#0b1512">
<meta property="og:site_name" content="Logosell">
${extra}
<style>${CSS}</style>`;
}

/** The honest footer. The app is not on the Play Store yet and registration is
 *  open, not invite-only: the old renderer said "Get an invite to Logosell" and
 *  pointed at /join, which redirects to a coming-soon page. A stranger who
 *  follows a shared link is told what Logosell is and where it is starting —
 *  nothing it cannot deliver today. */
const LAUNCH_NOTE =
  'Logosell is a UK marketplace built around meeting safely, in person. Starting in Hounslow.';

/*
  ── Shop mode: the helpers ──────────────────────────────────────────────────

  A verified trader's pages show NO price anywhere: not in the title, h1,
  og:title, product:price:* or structured data, and not in a list row. Instead
  the page says "Ask in store". The reasoning is the owner's: a page without a
  price is probably not an "invitation to purchase" (DMCC Act 2024 s.230(10),
  CMA207 4.11), whereas the same page with one probably is. That makes the
  absence of a price a legal obligation, which is why shop_test.ts scans every
  shop page for it. Which sellers are traders is decided in app.ts; everything
  here only renders what it is told.
*/

export const SHOP_NOTE = 'Sold in store only. Logosell does not take payment.';
const ASK_IN_STORE = 'Ask in store';
const ITEM_FALLBACK = 'Item in store';

/** Whose listing this is, lower-cased so it can be looked up in a set of ids. */
export function sellerIdOf(l: Listing): string | null {
  const id = l.seller_id ?? l.seller?.id ?? null;
  return typeof id === 'string' && id ? id.toLowerCase() : null;
}

/** Nothing, or only the invisible characters a person could slip between a currency
 *  sign and its digits to dodge a plain match. */
const GAP = String.raw`[\s\u200b-\u200d\u2060\ufeff]*`;
/** 4871, 4,871, 4871.50, and 4 871 (groups of three after a space). */
const AMOUNT = String.raw`\d[\d,]*(?:\.\d+)?(?:[^\S\r\n]\d{3}(?!\d))*`;
const UNIT = String.raw`(?:gbp|eur|usd|pounds?|quid|euros?|dollars?|bucks)`;
const CODE = String.raw`(?:gbp|eur|usd)`;
/** &pound; &euro; &#163; &#xA3; and the other currency entities, written out in full,
 *  and once or twice escaped again (&amp;pound;) as a layer that escapes twice leaves them. */
const ENTITY = String.raw`&(?:amp;)*(?:pound|euro|dollar|yen|cent|curren|#0*(?:163|8364|36|165|162)|#x0*(?:a3|20ac|24|a5|a2));`;

/** A price as a shop might type it: £120, $20, 1,250 GBP, 15 quid, GBP 40, &pound;9. */
const PRICE_TEXT: RegExp[] = [
  new RegExp(String.raw`\p{Sc}${GAP}${AMOUNT}(?:\s*[km]\b)?`, 'giu'),
  new RegExp(`${ENTITY}${GAP}${AMOUNT}`, 'giu'),
  new RegExp(String.raw`${AMOUNT}${GAP}${UNIT}\b`, 'giu'),
  new RegExp(String.raw`\b${CODE}${GAP}${AMOUNT}`, 'giu'),
];
const LOOSE_SIGN = new RegExp(`${ENTITY}|\\p{Sc}`, 'giu');
const MAX_SHOP_TEXT = 4000;

/**
 * Best-effort removal of a typed price from text a SHOP wrote: its title, its
 * description, its city, its trading name. The renderer controls every price IT
 * prints, but a shop can type "£120" into a title, and a shop page that carries a
 * price is the thing this mode exists to prevent.
 *
 * It is a net, not a wall. It catches a currency sign (any, not only the pound)
 * with an amount, an amount with pounds/GBP/quid, "GBP 40", an HTML pound entity,
 * and the fullwidth and zero-width tricks that would get past a plain match. It
 * cannot catch "twenty pounds", an obfuscated "1 2 0", a bare "4871", or a price
 * in a photo. Text without a price comes back unchanged, byte for byte, up to
 * MAX_SHOP_TEXT characters: nothing a shop page prints is longer than that, and a
 * bound is what keeps the matching fast when the text is a million digits.
 */
export function withoutPrices(text: unknown): string {
  const input = String(text ?? '').slice(0, MAX_SHOP_TEXT);
  // Matched on the NFKC form, so a fullwidth "￡１２０" is seen for what it is. The input
  // is only replaced by that form when a price was found in it.
  const folded = input.normalize('NFKC');
  let out = folded;
  for (const re of PRICE_TEXT) out = out.replace(re, '');
  out = out.replace(LOOSE_SIGN, '');
  if (out === folded) return input;
  return out
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s\-–—:,;|/]+|[\s\-–—:,;|/]+$/g, '')
    .trim();
}

const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * One line about today's opening, from shop_front's hours_today and open_now.
 * hours_today is a public database column, so it is treated as untrusted: every
 * range must be the exact "HH:MM" shape the database itself enforces
 * (valid_opening_hours, migration 0147) or the whole line is dropped.
 *
 *   hours never set      -> null            (say nothing. open_now is false for a
 *                                            shop that simply has not filled its
 *                                            hours in, and "Closed now" would be
 *                                            a claim we cannot back)
 *   closed all day       -> "Closed today"
 *   ranges, open         -> "Open now · Today 09:00–17:30"
 *   ranges, not open     -> "Closed now · Today 09:00–12:00, 13:00–17:30"
 *   ranges, open_now unknown -> "Today 09:00–17:30"
 *   anything malformed   -> null
 */
export function shopHours(shop: ShopFront | null | undefined): string | null {
  const raw = shop?.hours_today;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return 'Closed today';
  const ranges = raw.filter((r) =>
    Array.isArray(r) && r.length === 2 && HHMM.test(String(r[0])) && HHMM.test(String(r[1])));
  if (ranges.length !== raw.length) return null;
  const today = `Today ${ranges.map((r) => `${r[0]}–${r[1]}`).join(', ')}`;
  if (typeof shop?.open_now !== 'boolean') return today;
  return `${shop.open_now ? 'Open now' : 'Closed now'} · ${today}`;
}

/** The name a shop trades under: its business name, then its profile name, then
 *  whatever the caller has. Run through withoutPrices like every other string
 *  the shop typed, so "no pound sign anywhere on a shop page" has no exception. */
function shopName(shop: ShopFront | null | undefined, fallback?: string | null): string {
  for (const candidate of [shop?.business_name, shop?.display_name, fallback]) {
    const name = withoutPrices(candidate).trim();
    if (name) return name;
  }
  return 'A local shop';
}

export function listingPage(opts: {
  id: string; listing: Listing; origin: string;
}): string {
  const { id, listing: l, origin } = opts;
  const title = esc(l.title);
  const price = gbp(l.price_gbp);
  const img = safeImage(l.images);
  const desc = esc((l.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200));
  const seller = esc(l.seller?.display_name || 'A Logosell member');
  const cond = esc(CONDITION_LABEL[String(l.condition)] ?? '');
  const city = esc(l.city ?? '');
  const canonical = `${origin}/listing/${esc(id)}`;

  // Product/Offer structured data: this is what makes a Google result show the
  // price and availability instead of a bare blue link. Built from the same
  // escaped values as the page, and only emitted for fields we actually have.
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: l.title,
    ...(l.description ? { description: String(l.description).slice(0, 500) } : {}),
    ...(img ? { image: [img] } : {}),
    ...(l.condition && CONDITION_SCHEMA[String(l.condition)]
      ? { itemCondition: CONDITION_SCHEMA[String(l.condition)] } : {}),
    offers: {
      '@type': 'Offer',
      price: Number(l.price_gbp ?? 0),
      priceCurrency: 'GBP',
      availability: 'https://schema.org/InStock',
      url: canonical,
      ...(l.city ? { areaServed: String(l.city) } : {}),
      ...(l.seller?.display_name
        ? { seller: { '@type': 'Person', name: String(l.seller.display_name) } } : {}),
    },
  }).replace(/</g, '\\u003c');

  const og = `<meta name="description" content="${desc}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="product">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${title} — ${price}">
<meta property="og:description" content="${desc || LAUNCH_NOTE}">
${img ? `<meta property="og:image" content="${esc(img)}">
<meta property="og:image:alt" content="${title}">` : `<meta property="og:image" content="${origin}/og-image.png">`}
<meta name="twitter:card" content="summary_large_image">
<meta property="product:price:amount" content="${Number(l.price_gbp ?? 0)}">
<meta property="product:price:currency" content="GBP">
<script type="application/ld+json">${jsonLd}</script>`;

  return `<!doctype html>
<html lang="en"><head>
${head(`${title} — ${price} on Logosell`, og)}
</head><body><div class="wrap">
  <a class="brand" href="${origin}/">◆ Logosell</a>
  <div class="card">
    ${img ? `<img class="img" src="${esc(img)}" alt="${title}">` : ''}
    <div class="body">
      <h1>${title}</h1>
      <div class="price">${price}</div>
      <div>${cond ? `<span class="badge">${cond}</span>` : ''}${
        l.zone_slug ? `<a class="badge nolink" href="${origin}/${esc(l.zone_slug)}">📍 ${esc(zoneName(l.zone_slug))}</a>`
                    : city ? `<span class="badge">📍 ${city}</span>` : ''}</div>
      ${desc ? `<p class="muted gap">${desc}</p>` : ''}
      <p class="muted">Listed by ${seller}</p>
      <a class="cta" href="${origin}/">See Logosell</a>
      <a class="cta2" href="logosell://listing/${esc(id)}">Already a member? Open in the app</a>
    </div>
  </div>
  <p class="note muted">${LAUNCH_NOTE}</p>
</div></body></html>`;
}

/** One line of a list of listings. Shared by the seller page and the zone
 *  pages so a card cannot drift between them. With `asShop` the line carries no
 *  price, only "Ask in store"; without it the markup is exactly what it was
 *  before shop mode existed (golden_test.ts holds it to that). */
function listingRow(l: Listing, origin: string, asShop = false): string {
  const img = safeImage(l.images);
  if (asShop) {
    const title = esc(withoutPrices(l.title) || ITEM_FALLBACK);
    const city = withoutPrices(l.city);
    return `<a class="row" href="${origin}/listing/${esc(l.id)}">
      ${img ? `<img class="thumb" src="${esc(img)}" alt="${title}">` : '<div class="thumb"></div>'}
      <div class="grow"><div class="ttl">${title}</div>
      <div class="muted">${ASK_IN_STORE}${city ? ' · ' + esc(city) : ''}</div></div></a>`;
  }
  return `<a class="row" href="${origin}/listing/${esc(l.id)}">
      ${img ? `<img class="thumb" src="${esc(img)}" alt="${esc(l.title)}">` : '<div class="thumb"></div>'}
      <div class="grow"><div class="ttl">${esc(l.title)}</div>
      <div class="muted">${gbp(l.price_gbp)}${l.city ? ' · ' + esc(l.city) : ''}</div></div></a>`;
}

export function sellerPage(opts: {
  id: string; seller: Seller; listings: Listing[]; origin: string;
}): string {
  const { id, seller: s, listings, origin } = opts;
  const name = esc(s.display_name || 'A Logosell member');
  const canonical = `${origin}/seller/${esc(id)}`;
  const count = listings.length;
  const desc = esc(
    count ? `${count} item${count === 1 ? '' : 's'} for sale on Logosell${s.city ? ' in ' + s.city : ''}.`
          : LAUNCH_NOTE);

  const og = `<meta name="description" content="${desc}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="profile">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${name} on Logosell">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${origin}/og-image.png">
<meta name="twitter:card" content="summary">`;

  const rows = listings.map((l) => listingRow(l, origin)).join('\n');

  return `<!doctype html>
<html lang="en"><head>
${head(`${name} on Logosell`, og)}
</head><body><div class="wrap">
  <a class="brand" href="${origin}/">◆ Logosell</a>
  <div class="card"><div class="body">
    <h1>${name}</h1>
    <p class="muted">Member${s.city ? ' · ' + esc(s.city) : ''}${
      s.rating_count ? ` · ${esc(s.rating)}★ (${esc(s.rating_count)})` : ''}</p>
    ${rows || '<p class="muted">Nothing listed right now.</p>'}
    <a class="cta" href="${origin}/">See Logosell</a>
  </div></div>
  <p class="note muted">${LAUNCH_NOTE}</p>
</div></body></html>`;
}

/**
 * A zone page, and a zone+category page. THIS is the thing a person actually
 * searches for — "second hand sofa Hounslow", not "Logosell" — and until now
 * there was nothing for Google to index: the sitemap held three URLs, all legal
 * pages. One page per place, and one per place and category, built from real
 * inventory.
 *
 * An empty zone is deliberately `noindex`: a page that says "nothing here" is
 * worse than no page, because Google remembers it. It still renders for a human
 * who followed a link.
 */
export function zonePage(opts: {
  zone: Zone; listings: Listing[]; categories: CategoryCount[];
  activeCategory?: CategoryCount | null; origin: string;
  /** Ids (lower-case) of the verified traders. Given, a listing from one of them
   *  is shown without a price, and so is one whose seller cannot be identified:
   *  an unknown seller is treated as a shop, never as a person. Left out, every
   *  row is person-to-person, exactly as before shop mode. */
  traders?: ReadonlySet<string>;
}): string {
  const { zone, listings, categories, activeCategory: cat, origin, traders } = opts;
  const asShop = (l: Listing): boolean => {
    if (!traders) return false;
    const seller = sellerIdOf(l);
    return seller === null || traders.has(seller);
  };
  const path = cat ? `/${esc(zone.slug)}/${esc(cat.id)}` : `/${esc(zone.slug)}`;
  const canonical = `${origin}${path}`;
  // `title` stays raw text and is escaped exactly once, where it is written out.
  // It used to carry esc(zone.name) and then pass through esc() again, so a zone
  // called "Houn<slow" came out as &amp;lt; in the HTML and as &lt; in the JSON-LD.
  const what = esc(cat ? cat.name : 'Second-hand things');
  const title = cat
    ? `${cat.name} for sale in ${zone.name}`
    : `Buy and sell in ${zone.name}`;
  const n = listings.length;
  const desc = esc(n
    ? `${n} ${n === 1 ? 'item' : 'items'} for sale in ${zone.name}` +
      `${cat ? ', ' + cat.name.toLowerCase() : ''}. Collected in person, nearby.`
    : `${LAUNCH_NOTE}`);

  // An ItemList of the first few, so a result can show more than a blue link.
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: title,
    numberOfItems: n,
    itemListElement: listings.slice(0, 20).map((l, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${origin}/listing/${l.id}`,
      name: asShop(l) ? withoutPrices(l.title) || ITEM_FALLBACK : l.title,
    })),
  }).replace(/</g, '\\u003c');

  const og = `<meta name="description" content="${desc}">
<link rel="canonical" href="${canonical}">
${n === 0 ? '<meta name="robots" content="noindex">' : ''}
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${esc(title)} — Logosell">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${origin}/og-image.png">
<meta name="twitter:card" content="summary">
${n ? `<script type="application/ld+json">${jsonLd}</script>` : ''}`;

  const chips = categories.map((c) =>
    c.id === cat?.id
      ? `<span class="badge">${esc(c.emoji ?? '')} ${esc(c.name)} · ${c.n}</span>`
      : `<a class="badge nolink" href="${origin}/${esc(zone.slug)}/${esc(c.id)}">${
          esc(c.emoji ?? '')} ${esc(c.name)} · ${c.n}</a>`).join('');

  return `<!doctype html>
<html lang="en"><head>
${head(`${esc(title)} — Logosell`, og)}
</head><body><div class="wrap">
  <a class="brand" href="${origin}/">◆ Logosell</a>
  <div class="card"><div class="body">
    <h1>${esc(title)}</h1>
    <p class="muted">${what} in ${esc(zone.name)}, collected in person.${
      cat ? ` <a href="${origin}/${esc(zone.slug)}">All categories</a>` : ''}</p>
    ${chips ? `<div class="chips">${chips}</div>` : ''}
    ${n ? listings.map((l) => listingRow(l, origin, asShop(l))).join('\n')
        : '<p class="muted">Nothing listed here yet.</p>'}
    <a class="cta" href="${origin}/">See Logosell</a>
  </div></div>
  <p class="note muted">${LAUNCH_NOTE}</p>
</div></body></html>`;
}

/** Shown for an id that does not exist, a sold or hidden listing, and anything
 *  inside a private circle. Deliberately says nothing about which of those it
 *  is: "no public page" must look the same as "never existed", or the page
 *  becomes an oracle for whether a private listing exists. */
export function unavailablePage(origin: string): string {
  return `<!doctype html>
<html lang="en"><head>
${head('Logosell', `<meta name="robots" content="noindex">
<meta property="og:title" content="Logosell">
<meta property="og:description" content="${LAUNCH_NOTE}">
<meta property="og:image" content="${origin}/og-image.png">`)}
</head><body><div class="wrap">
  <a class="brand" href="${origin}/">◆ Logosell</a>
  <div class="card"><div class="body">
    <h1>This item isn't available</h1>
    <p class="muted">It may have sold, or it was never public.</p>
    <a class="cta" href="${origin}/">See Logosell</a>
  </div></div>
  <p class="note muted">${LAUNCH_NOTE}</p>
</div></body></html>`;
}

/** The sitemap GitHub Pages served had three URLs, all legal pages. Google had
 *  no listing to index because no listing had a page. */
export function sitemap(opts: {
  origin: string;
  listings: { id: string; created_at?: string | null }[];
  sellerIds?: string[];
  /** Only zones that actually hold something: an empty zone page is noindex, so
   *  listing it in the sitemap would be asking Google to fetch a page we then
   *  tell it to forget. */
  zonePaths?: string[];
}): string {
  const { origin, listings, sellerIds = [], zonePaths = [] } = opts;
  const statics = ['/', '/privacy.html', '/terms.html', '/delete-account.html'];
  const url = (loc: string, lastmod?: string | null) =>
    `  <url><loc>${esc(origin + loc)}</loc>${
      lastmod ? `<lastmod>${esc(String(lastmod).slice(0, 10))}</lastmod>` : ''}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${statics.map((s) => url(s)).join('\n')}
${zonePaths.map((z) => url(z)).join('\n')}
${listings.map((l) => url(`/listing/${l.id}`, l.created_at)).join('\n')}
${sellerIds.map((s) => url(`/seller/${s}`)).join('\n')}
</urlset>`;
}

/*
  ── Shop mode: the pages ────────────────────────────────────────────────────

  What these two have in common, and what the tests hold them to:

    - No price, in any form. Not in <title>, <h1>, og:title, product:price:*,
      a list row, or structured data. There is no JSON-LD at all: a Product
      without an Offer earns nothing in search, and one with an Offer is the
      thing this mode exists to prevent.
    - No address, no rating, no "N sold". The shop's address is hidden from
      logged-out callers by the database (migration 0149), and ratings and sales
      counts are person-to-person trust signals this mode does not use.
    - Every string a shop typed goes through withoutPrices first.
    - No inline style="…". The CSP pins the one <style> block by hash, so a new
      look has to come from a class that already exists in CSS.
*/

/**
 * A listing page for a verified trader's stock: the item, the shop that has it,
 * today's opening hours when the shop gave them, and where to go. `shop` is
 * optional because the hours come from a second read that can fail; the page is
 * still correct without them, only shorter.
 */
export function shopListingPage(opts: {
  id: string; listing: Listing; origin: string; shop?: ShopFront | null;
}): string {
  const { id, listing: l, origin, shop } = opts;
  const title = esc(withoutPrices(l.title) || ITEM_FALLBACK);
  const img = safeImage(l.images);
  const desc = esc(withoutPrices(l.description).replace(/\s+/g, ' ').trim().slice(0, 200));
  const blurb = desc || esc(`${ASK_IN_STORE}. ${SHOP_NOTE}`);
  const name = esc(shopName(shop, l.seller?.display_name));
  const cond = esc(CONDITION_LABEL[String(l.condition)] ?? '');
  const city = esc(withoutPrices(l.city));
  const canonical = `${origin}/listing/${esc(id)}`;
  const sellerId = sellerIdOf(l);
  const hours = shopHours(shop);

  const og = `<meta name="description" content="${blurb}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${title} — ${name}">
<meta property="og:description" content="${blurb}">
${img ? `<meta property="og:image" content="${esc(img)}">
<meta property="og:image:alt" content="${title}">` : `<meta property="og:image" content="${origin}/og-image.png">`}
<meta name="twitter:card" content="summary_large_image">`;

  return `<!doctype html>
<html lang="en"><head>
${head(`${title} — ${name} on Logosell`, og)}
</head><body><div class="wrap">
  <a class="brand" href="${origin}/">◆ Logosell</a>
  <div class="card">
    ${img ? `<img class="img" src="${esc(img)}" alt="${title}">` : ''}
    <div class="body">
      <h1>${title}</h1>
      <div><span class="badge">${ASK_IN_STORE}</span>${cond ? `<span class="badge">${cond}</span>` : ''}${
        l.zone_slug ? `<a class="badge" href="${origin}/${esc(l.zone_slug)}">📍 ${esc(zoneName(l.zone_slug))}</a>`
                    : city ? `<span class="badge">📍 ${city}</span>` : ''}</div>
      ${desc ? `<p class="muted">${desc}</p>` : ''}
      <p class="muted">Sold by ${name}${hours ? ` · ${esc(hours)}` : ''}</p>
      <p class="muted">${SHOP_NOTE}</p>
      ${sellerId ? `<a class="cta" href="${origin}/seller/${esc(sellerId)}">See the shop</a>`
                 : `<a class="cta" href="${origin}/">See Logosell</a>`}
      <a class="cta2" href="logosell://listing/${esc(id)}">Already a member? Open in the app</a>
    </div>
  </div>
  <p class="note muted">${LAUNCH_NOTE}</p>
</div></body></html>`;
}

/**
 * A verified trader's shop page: name, whether it is open and today's hours (when
 * the shop set them), how many pieces it has, and the in-store-only line, then
 * the stock as price-free rows. `listings` is what the database returned for the
 * seller (at most 40); the count shown is the larger of that and the shop's own
 * live count, so a shop with more than 40 pieces is not reported as having 40.
 */
export function shopSellerPage(opts: {
  id: string; seller: Seller; listings: Listing[]; origin: string; shop?: ShopFront | null;
}): string {
  const { id, seller: s, listings, origin, shop } = opts;
  const name = esc(shopName(shop, s.display_name));
  const canonical = `${origin}/seller/${esc(id)}`;
  const cityText = withoutPrices(shop?.city ?? s.city);
  const city = esc(cityText);
  const hours = shopHours(shop);
  const live = typeof shop?.listings_live === 'number' && Number.isFinite(shop.listings_live) &&
    shop.listings_live > 0 ? Math.floor(shop.listings_live) : 0;
  const total = Math.max(listings.length, live);
  const pieces = total
    ? `${total} piece${total === 1 ? '' : 's'} in store`
    : 'Nothing in store right now';
  const desc = esc(`${pieces}${total && cityText ? ' in ' + cityText : ''}. ${SHOP_NOTE}`);

  const og = `<meta name="description" content="${desc}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${name} on Logosell">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${origin}/og-image.png">
<meta name="twitter:card" content="summary">`;

  const rows = listings.map((l) => listingRow(l, origin, true)).join('\n');

  return `<!doctype html>
<html lang="en"><head>
${head(`${name} on Logosell`, og)}
</head><body><div class="wrap">
  <a class="brand" href="${origin}/">◆ Logosell</a>
  <div class="card"><div class="body">
    <h1>${name}</h1>
    <p class="muted">Shop${city ? ' · ' + city : ''}</p>
    ${hours ? `<p class="muted">${esc(hours)}</p>` : ''}
    <p class="muted">${pieces}</p>
    <p class="muted">${SHOP_NOTE}</p>
    ${rows}
    <a class="cta" href="${origin}/">See Logosell</a>
  </div></div>
  <p class="note muted">${LAUNCH_NOTE}</p>
</div></body></html>`;
}
