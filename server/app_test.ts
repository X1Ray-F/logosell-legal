import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { handle, originOf, ALLOWED_HOSTS, type Deps } from './app.ts';

const ID = '550e8400-e29b-41d4-a716-446655440000';
const env = { url: 'https://db.example.co', anon: 'anon-key' };

// A private seller. seller_id is NOT NULL in the database, so every real listing has one;
// shop mode needs it to decide whether the price may be shown (see shop_test.ts).
const SELLER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const listing = {
  id: ID, seller_id: SELLER, title: 'Oak dining table', price_gbp: 120, city: 'Hounslow',
  condition: 'good', images: ['https://db.example.co/l/1.jpg'], description: 'Seats six.',
  category_id: 'furniture', zone_slug: 'hounslow',
  seller: { id: SELLER, display_name: 'Priya', verified: true },
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
    // No network in a unit test. The default (the real reader) would answer "unknown",
    // and unknown fails closed, so these are what make a price page possible at all.
    fetchTraders: () => Promise.resolve(new Set<string>()),
    fetchShop: () => Promise.resolve(null),
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
                   '/p/FOUNDER-1', '/robots.txt', '/s.html']) {
    const res = await handle(get(p), d);
    assertEquals(res.status, 200, p);
    assertEquals(await res.text(), 'static');
  }
  assertEquals(d.staticHits.length, 7);
  // /.well-known/assetlinks.json used to be in this list and is not any more: the
  // static handler cannot serve a dot-segment path, so the server answers it itself
  // (see wellknown_test.ts). /s.html with no query is still the file: it is only
  // redirected when it carries a listing or seller id to render (shop_test.ts).
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

/*
  ── Which hosts may name themselves ─────────────────────────────────────────────────────────

  Production is https://logosell-web.x1ray-f.deno.net (RUNBOOK.md). The allowlist once said
  `deno.dev`, the old Deploy Classic domain, so on the real host every canonical, og:url and
  sitemap entry fell back to https://logosell.app, which was still GitHub Pages and answered
  404 for /hounslow. Nothing noticed, because every test used logosell.app or localhost.
*/

const PRODUCTION = 'https://logosell-web.x1ray-f.deno.net';

/** The production URL as RUNBOOK.md writes it, so the test follows the document and not a
 *  copy of it. If the document is reworded so this stops matching, fail loudly: a silent
 *  pass here would bring the bug back. */
async function productionFromRunbook(): Promise<string> {
  const text = await Deno.readTextFile(new URL('./RUNBOOK.md', import.meta.url));
  const m = /producție\s*:\s*(https:\/\/[^\s`]+)/u.exec(text);
  if (!m) {
    throw new Error('RUNBOOK.md no longer says "producție : https://…"; fix the RUNBOOK or this test');
  }
  return m[1].replace(/\/+$/, '');
}

Deno.test('the production host names itself, not the fallback', () => {
  assertEquals(originOf(new Request(`${PRODUCTION}/hounslow`), ALLOWED_HOSTS), PRODUCTION);
});

Deno.test('the production host written in RUNBOOK.md is covered by ALLOWED_HOSTS', async () => {
  const prod = await productionFromRunbook();
  assertEquals(originOf(new Request(`${prod}/hounslow`), ALLOWED_HOSTS), prod, prod);
});

Deno.test('on the production host canonical, og:url and links stay on the production host', async () => {
  const prod = await productionFromRunbook();
  for (const [path, canonical] of [
    ['/hounslow', `${prod}/hounslow`],
    ['/hounslow/furniture', `${prod}/hounslow/furniture`],
    [`/listing/${ID}`, `${prod}/listing/${ID}`],
    [`/seller/${SELLER}`, `${prod}/seller/${SELLER}`],
  ] as const) {
    const res = await handle(new Request(`${prod}${path}`), deps());
    assertEquals(res.status, 200, path);
    const body = await res.text();
    assertStringIncludes(body, `<link rel="canonical" href="${canonical}">`);
    assertStringIncludes(body, `<meta property="og:url" content="${canonical}">`);
    // Nothing in the page may point back at the fallback origin.
    assert(!body.includes('https://logosell.app'), `${path} links to the fallback origin`);
  }
});

Deno.test('on the production host the sitemap lists production URLs', async () => {
  const prod = await productionFromRunbook();
  const res = await handle(new Request(`${prod}/sitemap.xml`), deps());
  const xml = await res.text();
  assertStringIncludes(xml, `<loc>${prod}/listing/${ID}</loc>`);
  assertStringIncludes(xml, `<loc>${prod}/hounslow</loc>`);
  assert(!xml.includes('https://logosell.app'), 'sitemap falls back to the other origin');
});

Deno.test('a host that only looks like ours is refused', () => {
  for (const evil of [
    'https://logosell-web.x1ray-f.deno.net.evil.com',  // ours as a prefix
    'https://evilx1ray-f.deno.net',                    // ours as a suffix without the dot
    'https://x1ray-f.deno.net.evil.com',
    'https://other-org.deno.net',                      // another Deploy tenant
    'https://deno.net',                                // the parent domain
    'https://logosell.app.evil.com',
  ]) {
    assertEquals(originOf(new Request(`${evil}/hounslow`), ALLOWED_HOSTS), 'https://logosell.app', evil);
  }
});

Deno.test('every ALLOWED_HOSTS entry is a bare host name that the matcher can really match', () => {
  // originOf accepts `name === entry` or `name.endsWith('.' + entry)`. An entry with a leading
  // dot (".deno.net"), a wildcard ("*.deno.net"), a scheme or a port matches nothing and fails
  // silently, which is exactly how a "fix" for the production host would look like it worked.
  for (const entry of ALLOWED_HOSTS) {
    assert(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(entry), `"${entry}" cannot match a host name`);
    assert(!entry.includes('..'), `"${entry}" has an empty label`);
  }
  assert(ALLOWED_HOSTS.includes('logosell.app'));
});
