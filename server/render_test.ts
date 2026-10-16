import { assert, assertEquals, assertStringIncludes, assertFalse } from 'jsr:@std/assert@1';
import { listingPage, sellerPage, zonePage, unavailablePage, sitemap, gbp, safeImage, zoneName } from './render.ts';

const ORIGIN = 'https://logosell.app';
const ID = '550e8400-e29b-41d4-a716-446655440000';

const base = {
  id: ID,
  title: 'Oak dining table',
  description: 'Solid oak, seats six.  Collected from Hounslow.',
  price_gbp: 120,
  images: ['https://ppqormwtsuprottekulj.supabase.co/storage/v1/object/public/l/1.jpg'],
  city: 'Hounslow',
  condition: 'good',
  created_at: '2026-10-14T09:00:00Z',
  seller: { display_name: 'Priya', verified: true },
};

Deno.test('gbp formats pounds with a thousands separator', () => {
  assertEquals(gbp(120), '£120');
  assertEquals(gbp(1250), '£1,250');
  assertEquals(gbp(null), '£0');
  assertEquals(gbp('nonsense'), '£0');
});

Deno.test('a shared listing previews with its own title, price and photo', () => {
  const h = listingPage({ id: ID, listing: base, origin: ORIGIN });
  // The exact three things a scraper got wrong before: title, price, image.
  assertStringIncludes(h, '<title>Oak dining table — £120 on Logosell</title>');
  assertStringIncludes(h, '<meta property="og:title" content="Oak dining table — £120">');
  assertStringIncludes(h, `<meta property="og:image" content="${base.images[0]}">`);
  assertStringIncludes(h, `<meta property="og:url" content="${ORIGIN}/listing/${ID}">`);
  assertStringIncludes(h, '<meta property="og:type" content="product">');
  assertStringIncludes(h, `<link rel="canonical" href="${ORIGIN}/listing/${ID}">`);
});

Deno.test('the page carries Product/Offer structured data that parses', () => {
  const h = listingPage({ id: ID, listing: base, origin: ORIGIN });
  const m = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(h);
  assert(m, 'no JSON-LD block');
  const ld = JSON.parse(m[1]);
  assertEquals(ld['@type'], 'Product');
  assertEquals(ld.offers.price, 120);
  assertEquals(ld.offers.priceCurrency, 'GBP');
  assertEquals(ld.offers.url, `${ORIGIN}/listing/${ID}`);
  assertEquals(ld.itemCondition, 'https://schema.org/UsedCondition');
});

Deno.test('a title that is an injection attempt is escaped everywhere it lands', () => {
  const nasty = `"><script>alert('x')</script>`;
  const h = listingPage({ id: ID, listing: { ...base, title: nasty }, origin: ORIGIN });
  assertFalse(h.includes('<script>alert'), 'raw script tag reached the page');
  assertStringIncludes(h, '&lt;script&gt;');
  // And it must not have broken out of the og:title attribute.
  assertFalse(/content="[^"]*"><script/.test(h));
  // JSON-LD must still parse with the hostile title inside it.
  const m = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(h);
  assert(m);
  assertEquals(JSON.parse(m[1]).name, nasty);
});

Deno.test('only an https image is echoed into og:image and the img tag', () => {
  assertEquals(safeImage(['javascript:alert(1)']), '');
  assertEquals(safeImage(['data:image/png;base64,AAA']), '');
  assertEquals(safeImage(['http://example.com/a.jpg']), '');
  assertEquals(safeImage(null), '');
  assertEquals(safeImage(['https://x/a.jpg']), 'https://x/a.jpg');

  const h = listingPage({ id: ID, listing: { ...base, images: ['javascript:alert(1)'] }, origin: ORIGIN });
  assertFalse(h.includes('javascript:alert'));
  // Falls back to the site image rather than emitting no og:image at all.
  assertStringIncludes(h, `<meta property="og:image" content="${ORIGIN}/og-image.png">`);
});

Deno.test('a missing or private listing says nothing about which it is', () => {
  const h = unavailablePage(ORIGIN);
  assertStringIncludes(h, '<meta name="robots" content="noindex">');
  assertStringIncludes(h, "This item isn't available");
  // No hint that a private circle exists — checked against the visible copy,
  // not the whole document: the stylesheet legitimately contains "hidden".
  const visible = h.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
  assertFalse(/circle|private|hidden|moderat/i.test(visible), visible);
});

Deno.test('a seller page lists their items and links each one', () => {
  const h = sellerPage({
    id: ID,
    seller: { display_name: 'Priya', verified: true, city: 'Hounslow', rating: 4.8, rating_count: 12 },
    listings: [base, { ...base, id: 'b2', title: 'Lamp', price_gbp: 15 }],
    origin: ORIGIN,
  });
  assertStringIncludes(h, '<title>Priya on Logosell</title>');
  assertStringIncludes(h, `href="${ORIGIN}/listing/${ID}"`);
  assertStringIncludes(h, `href="${ORIGIN}/listing/b2"`);
  assertStringIncludes(h, '4.8★ (12)');
  assertStringIncludes(h, '2 items for sale');
});

Deno.test('the sitemap carries real listings, not just the legal pages', () => {
  const xml = sitemap({
    origin: ORIGIN,
    listings: [{ id: ID, created_at: '2026-10-14T09:00:00Z' }, { id: 'x2' }],
  });
  assertStringIncludes(xml, '<?xml version="1.0" encoding="UTF-8"?>');
  assertStringIncludes(xml, `<loc>${ORIGIN}/listing/${ID}</loc>`);
  assertStringIncludes(xml, '<lastmod>2026-10-14</lastmod>');
  assertStringIncludes(xml, `<loc>${ORIGIN}/privacy.html</loc>`);
  // The three legal URLs the old sitemap had, plus the landing page.
  assertEquals((xml.match(/<url>/g) ?? []).length, 6);
});

Deno.test('a listing with no description still gets a usable og:description', () => {
  const h = listingPage({ id: ID, listing: { ...base, description: null }, origin: ORIGIN });
  assertStringIncludes(h, 'og:description" content="Logosell is a UK marketplace');
});

Deno.test('a slug reads as a place name', () => {
  assertEquals(zoneName('hounslow'), 'Hounslow');
  assertEquals(zoneName('waltham-forest'), 'Waltham Forest');
  assertEquals(zoneName('barking-and-dagenham'), 'Barking and Dagenham');
  assertEquals(zoneName('kingston-upon-thames'), 'Kingston upon Thames');
  assertEquals(zoneName('city-of-london'), 'City of London');
});

Deno.test('a zone page carries an ItemList that parses', () => {
  const h = zonePage({
    zone: { slug: 'hounslow', name: 'Hounslow' },
    listings: [base, { ...base, id: 'x2', title: 'Lamp' }],
    categories: [{ id: 'furniture', name: 'Furniture', emoji: null, n: 2 }],
    origin: ORIGIN,
  });
  const m = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(h);
  assert(m, 'no JSON-LD on the zone page');
  const ld = JSON.parse(m[1]);
  assertEquals(ld['@type'], 'ItemList');
  assertEquals(ld.numberOfItems, 2);
  assertEquals(ld.itemListElement[0].url, `${ORIGIN}/listing/${ID}`);
});

Deno.test('a hostile zone name cannot break out of the page', () => {
  const h = zonePage({
    zone: { slug: 'x', name: '"><script>alert(1)</script>' },
    listings: [], categories: [], origin: ORIGIN,
  });
  assertFalse(h.includes('<script>alert'));
  assertStringIncludes(h, '&lt;script&gt;');
});
