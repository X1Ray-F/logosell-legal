import { assert, assertEquals, assertStringIncludes, assertFalse } from 'jsr:@std/assert@1';
import { fetchListing, fetchSeller, fetchPublicListings, UUID_RE } from './data.ts';

const env = { url: 'https://db.example.co', anon: 'anon-key' };
const ID = '550e8400-e29b-41d4-a716-446655440000';

/** Replaces fetch for one test and records what was asked for. */
function stubFetch(reply: (url: string) => { ok?: boolean; body?: unknown }) {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const r = reply(url);
    return Promise.resolve(new Response(JSON.stringify(r.body ?? []), {
      status: r.ok === false ? 500 : 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

Deno.test('the uuid gate holds: a crafted id never reaches PostgREST', async () => {
  const f = stubFetch(() => ({ body: [{ id: 'leaked' }] }));
  try {
    // This is the attack the gate exists for: a second select= would append to
    // the query string and drop the circle_id / status filters.
    assertEquals(await fetchListing(env, `${ID}&select=*`), null);
    assertEquals(await fetchListing(env, '../../rpc/admin_thing'), null);
    assertEquals(await fetchListing(env, ''), null);
    assertEquals(f.calls.length, 0, 'the database was queried with a bad id');
  } finally { f.restore(); }
  assertFalse(UUID_RE.test(`${ID}&select=*`));
  assert(UUID_RE.test(ID));
});

Deno.test('a public page is only ever built from an active, visible, non-circle listing', async () => {
  const f = stubFetch(() => ({ body: [{ id: ID, title: 'T', price_gbp: 1 }] }));
  try {
    await fetchListing(env, ID);
    assertEquals(f.calls.length, 1);
    const url = f.calls[0];
    assertStringIncludes(url, 'status=eq.active');
    assertStringIncludes(url, 'hidden=is.false');
    assertStringIncludes(url, 'circle_id=is.null');
    assertStringIncludes(url, `id=eq.${ID}`);
  } finally { f.restore(); }
});

Deno.test('reads go to the markety schema, not public', async () => {
  const real = globalThis.fetch;
  let headers: Record<string, string> = {};
  globalThis.fetch = ((_u: string, init?: RequestInit) => {
    headers = (init?.headers ?? {}) as Record<string, string>;
    return Promise.resolve(new Response('[]', { status: 200 }));
  }) as typeof fetch;
  try {
    await fetchListing(env, ID);
    assertEquals(headers['Accept-Profile'], 'markety');
    assertEquals(headers.apikey, 'anon-key');
  } finally { globalThis.fetch = real; }
});

Deno.test('a database error renders nothing rather than half a page', async () => {
  const f = stubFetch(() => ({ ok: false }));
  try {
    assertEquals(await fetchListing(env, ID), null);
    assertEquals(await fetchSeller(env, ID), null);
    assertEquals(await fetchPublicListings(env), []);
  } finally { f.restore(); }
});

Deno.test('fetch throwing is not an unhandled rejection', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error('network'))) as typeof fetch;
  try {
    assertEquals(await fetchListing(env, ID), null);
  } finally { globalThis.fetch = real; }
});

Deno.test('without keys configured nothing is requested', async () => {
  const f = stubFetch(() => ({ body: [] }));
  try {
    assertEquals(await fetchListing({ url: '', anon: '' }, ID), null);
    assertEquals(f.calls.length, 0);
  } finally { f.restore(); }
});

Deno.test('a seller page asks for their listings under the same filters', async () => {
  const f = stubFetch((url) =>
    url.includes('profiles?') ? { body: [{ id: ID, display_name: 'Priya' }] } : { body: [] });
  try {
    const got = await fetchSeller(env, ID);
    assert(got);
    assertEquals(got.seller.display_name, 'Priya');
    const listingCall = f.calls.find((c) => c.includes('listings?'));
    assert(listingCall);
    assertStringIncludes(listingCall, 'status=eq.active');
    assertStringIncludes(listingCall, 'hidden=is.false');
    assertStringIncludes(listingCall, 'circle_id=is.null');
  } finally { f.restore(); }
});
