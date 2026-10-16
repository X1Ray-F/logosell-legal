import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { handle, originOf, ALLOWED_HOSTS, type Deps } from './app.ts';

const ID = '550e8400-e29b-41d4-a716-446655440000';
const env = { url: 'https://db.example.co', anon: 'anon-key' };

const listing = {
  id: ID, title: 'Oak dining table', price_gbp: 120, city: 'Hounslow', condition: 'good',
  images: ['https://db.example.co/l/1.jpg'], description: 'Seats six.',
  category_id: 'furniture', zone_slug: 'hounslow',
  seller: { display_name: 'Priya', verified: true },
};
const ZONE = { slug: 'hounslow', name: 'Hounslow' };
const CATS = [{ id: 'furniture', name: 'Furniture', emoji: '🪑', n: 1 }];

function deps(over: Partial<Deps> = {}): Deps & { staticHits: string[] } {
  const staticHits: string[] = [];
  return {
    env,
    staticHits,
    serveStatic: (req) => {
      staticHits.push(new URL(req.url).pathname);
      return Promise.resolve(new Response('static', { status: 200 }));
    },
    fetchListing: () => Promise.resolve(listing),
    fetchSeller: () => Promise.resolve({ seller: listing.seller, listings: [listing] }),
    fetchPublicListings: () => Promise.resolve(
      [{ id: ID, created_at: '2026-10-14T00:00:00Z', zone_slug: 'hounslow', category_id: 'furniture' }]),
    fetchZone: (_e: unknown, slug: string) =>
      Promise.resolve(slug === 'hounslow' ? ZONE : null),
    fetchZoneListings: () => Promise.resolve([listing]),
    fetchZoneCategories: () => Promise.resolve(CATS),
    ...over,
  } as Deps & { staticHits: string[] };
}

const get = (path: string, host = 'logosell.app') =>
  new Request(`https://${host}${path}`);

Deno.test('a shared listing URL now answers 200 with real html', async () => {
  const res = await handle(get(`/listing/${ID}`), deps());
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
  const body = await res.text();
  assertStringIncludes(body, '<meta property="og:title" content="Oak dining table — £120">');
});

Deno.test('the rendered page is served under a locked-down CSP', async () => {
  const res = await handle(get(`/listing/${ID}`), deps());
  const csp = res.headers.get('Content-Security-Policy') ?? '';
  assertStringIncludes(csp, "default-src 'none'");
  assertStringIncludes(csp, "style-src 'sha256-");
  assertStringIncludes(csp, 'img-src \'self\' https://db.example.co data:');
  assertStringIncludes(csp, "frame-ancestors 'none'");
  assertEquals(res.headers.get('Referrer-Policy'), 'no-referrer');
  assertEquals(res.headers.get('X-Content-Type-Options'), 'nosniff');
  await res.body?.cancel();
});

Deno.test('a malformed id is answered without touching the database', async () => {
  let called = 0;
  const d = deps({ fetchListing: () => { called++; return Promise.resolve(listing); } });
  const res = await handle(get('/listing/not-a-uuid'), d);
  assertEquals(res.status, 404);
  assertEquals(called, 0);
  assertStringIncludes(await res.text(), "This item isn't available");
});

Deno.test('a sold, hidden or private listing is a 404 that is never cached', async () => {
  const d = deps({ fetchListing: () => Promise.resolve(null) });
  const res = await handle(get(`/listing/${ID}`), d);
  assertEquals(res.status, 404);
  assertEquals(res.headers.get('Cache-Control'), 'no-store');
  await res.body?.cancel();
});

Deno.test('a found page is cached for five minutes', async () => {
  const res = await handle(get(`/listing/${ID}`), deps());
  assertEquals(res.headers.get('Cache-Control'), 'public, max-age=300');
  await res.body?.cancel();
});

Deno.test('a seller page renders their items', async () => {
  const res = await handle(get(`/seller/${ID}`), deps());
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), '<title>Priya on Logosell</title>');
});

Deno.test('writes are refused on the rendered routes', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await handle(
      new Request(`https://logosell.app/listing/${ID}`, { method }), deps());
    assertEquals(res.status, 405);
    assertEquals(res.headers.get('Allow'), 'GET, HEAD');
    await res.body?.cancel();
  }
});

Deno.test('the sitemap is xml and contains the live listing', async () => {
  const res = await handle(get('/sitemap.xml'), deps());
  assertEquals(res.headers.get('Content-Type'), 'application/xml; charset=utf-8');
  assertStringIncludes(await res.text(), `<loc>https://logosell.app/listing/${ID}</loc>`);
});

Deno.test('every other path still goes to the static site', async () => {
  const d = deps();
  for (const p of ['/', '/privacy.html', '/terms.html', '/m/0123456789abcdef0123456789abcdef',
                   '/p/FOUNDER-1', '/.well-known/assetlinks.json', '/robots.txt', '/s.html']) {
    const res = await handle(get(p), d);
    assertEquals(res.status, 200, p);
    assertEquals(await res.text(), 'static');
  }
  assertEquals(d.staticHits.length, 8);
  // App Links depend on this file being reachable, or shared links stop
  // opening in the app on Android.
  assert(d.staticHits.includes('/.well-known/assetlinks.json'));
});

Deno.test('a forged Host header cannot plant its domain in canonical or og:url', async () => {
  const res = await handle(get(`/listing/${ID}`, 'evil.example.com'), deps());
  const body = await res.text();
  assertStringIncludes(body, '<link rel="canonical" href="https://logosell.app/listing/');
  assert(!body.includes('evil.example.com'));
});

Deno.test('a preview deployment links to itself', () => {
  assertEquals(
    originOf(new Request('https://logosell-x.deno.dev/listing/a'), ALLOWED_HOSTS),
    'https://logosell-x.deno.dev');
  assertEquals(
    originOf(new Request('http://localhost:8000/listing/a'), ALLOWED_HOSTS),
    'http://localhost:8000');
  assertEquals(
    originOf(new Request('https://logosell.app.evil.com/listing/a'), ALLOWED_HOSTS),
    'https://logosell.app');
});

Deno.test('a zone has a page a person could have searched for', async () => {
  const res = await handle(get('/hounslow'), deps());
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, '<title>Buy and sell in Hounslow — Logosell</title>');
  assertStringIncludes(body, `href="https://logosell.app/listing/${ID}"`);
  assertStringIncludes(body, '<link rel="canonical" href="https://logosell.app/hounslow">');
  // A zone with something in it must be indexable.
  assert(!body.includes('name="robots" content="noindex"'));
});

Deno.test('a zone and a category together is its own page', async () => {
  const res = await handle(get('/hounslow/furniture'), deps());
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, '<title>Furniture for sale in Hounslow — Logosell</title>');
  assertStringIncludes(body, 'canonical" href="https://logosell.app/hounslow/furniture"');
  assertStringIncludes(body, 'ItemList');
});

Deno.test('a category a crawler guessed at is a 404, not an empty page', async () => {
  const res = await handle(get('/hounslow/aeroplanes'), deps());
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test('an empty zone renders but is never indexed', async () => {
  const d = deps({
    fetchZoneListings: () => Promise.resolve([]),
    fetchZoneCategories: () => Promise.resolve([]),
  });
  const res = await handle(get('/hounslow'), d);
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, '<meta name="robots" content="noindex">');
  assertStringIncludes(body, 'Nothing listed here yet');
});

Deno.test('the zone route does not swallow the static site', async () => {
  const d = deps();
  // /join is a real static page; 'join' is not a zone, so it must fall through
  // exactly as it did before this route existed.
  for (const p of ['/join', '/not-a-zone', '/privacy.html', '/robots.txt']) {
    const res = await handle(get(p), d);
    assertEquals(await res.text(), 'static', p);
  }
  assertEquals(d.staticHits.length, 4);
});

Deno.test('the sitemap lists the zone pages that actually hold something', async () => {
  const res = await handle(get('/sitemap.xml'), deps());
  const xml = await res.text();
  assertStringIncludes(xml, '<loc>https://logosell.app/hounslow</loc>');
  assertStringIncludes(xml, '<loc>https://logosell.app/hounslow/furniture</loc>');
});

Deno.test('a listing page links back to its zone', async () => {
  const res = await handle(get(`/listing/${ID}`), deps());
  const body = await res.text();
  assertStringIncludes(body, 'href="https://logosell.app/hounslow">📍 Hounslow');
});
