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

export interface Listing {
  id: string;
  title: string;
  description?: string | null;
  price_gbp: number;
  images?: string[] | null;
  city?: string | null;
  condition?: string | null;
  created_at?: string | null;
  seller?: Seller | null;
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

export function listingPage(opts: {
  id: string; listing: Listing; origin: string;
}): string {
  const { id, listing: l, origin } = opts;
  const title = esc(l.title);
  const price = gbp(l.price_gbp);
  const img = safeImage(l.images);
  const desc = esc((l.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200));
  const seller = esc(l.seller?.display_name || 'A verified member');
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
      <div>${cond ? `<span class="badge">${cond}</span>` : ''}${city ? `<span class="badge">📍 ${city}</span>` : ''}</div>
      ${desc ? `<p class="muted" style="margin-top:12px">${desc}</p>` : ''}
      <p class="muted">Listed by ${seller}${l.seller?.verified ? ' · ✓ verified' : ''}</p>
      <a class="cta" href="${origin}/">See Logosell</a>
      <a class="cta2" href="logosell://listing/${esc(id)}">Already a member? Open in the app</a>
    </div>
  </div>
  <p class="note muted">${LAUNCH_NOTE}</p>
</div></body></html>`;
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

  const rows = listings.map((l) => {
    const img = safeImage(l.images);
    return `<a class="row" href="${origin}/listing/${esc(l.id)}">
      ${img ? `<img class="thumb" src="${esc(img)}" alt="${esc(l.title)}">` : '<div class="thumb"></div>'}
      <div class="grow"><div class="ttl">${esc(l.title)}</div>
      <div class="muted">${gbp(l.price_gbp)}${l.city ? ' · ' + esc(l.city) : ''}</div></div></a>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en"><head>
${head(`${name} on Logosell`, og)}
</head><body><div class="wrap">
  <a class="brand" href="${origin}/">◆ Logosell</a>
  <div class="card"><div class="body">
    <h1>${name}</h1>
    <p class="muted">${s.verified ? '✓ Verified member' : 'Member'}${s.city ? ' · ' + esc(s.city) : ''}${
      s.rating_count ? ` · ${esc(s.rating)}★ (${esc(s.rating_count)})` : ''}</p>
    ${rows || '<p class="muted">Nothing listed right now.</p>'}
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
  origin: string; listings: { id: string; created_at?: string | null }[]; sellerIds?: string[];
}): string {
  const { origin, listings, sellerIds = [] } = opts;
  const statics = ['/', '/privacy.html', '/terms.html', '/delete-account.html'];
  const url = (loc: string, lastmod?: string | null) =>
    `  <url><loc>${esc(origin + loc)}</loc>${
      lastmod ? `<lastmod>${esc(String(lastmod).slice(0, 10))}</lastmod>` : ''}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${statics.map((s) => url(s)).join('\n')}
${listings.map((l) => url(`/listing/${l.id}`, l.created_at)).join('\n')}
${sellerIds.map((s) => url(`/seller/${s}`)).join('\n')}
</urlset>`;
}
