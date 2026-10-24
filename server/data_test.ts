import { assert, assertEquals, assertStringIncludes, assertFalse } from 'jsr:@std/assert@1';
import {
  fetchListing, fetchPublicListings, fetchSeller, fetchShop, fetchTraderIds, fetchZoneListings,
  fetchCategories, resetCatalogCache, resetTraderCache, UUID_RE,
} from './data.ts';

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

/* ── Shop mode: who is a verified trader, and the shop front ─────────────────────────────── */

const idN = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const T0 = 1_800_000_000_000;
/** Reads that started a list (the first page of one), not the pages that follow. */
const firstPages = (calls: string[]) => calls.filter((c) => !c.includes('profile_id=gt.'));

/** Replaces fetch and console.warn for one test; puts both back and forgets the trader list. */
async function withNetwork(
  reply: (url: string) => Response | Promise<Response>,
  body: (seen: { calls: string[]; inits: RequestInit[]; warnings: string[] }) => Promise<void>,
) {
  const seen = { calls: [] as string[], inits: [] as RequestInit[], warnings: [] as string[] };
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  resetTraderCache();
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    seen.calls.push(String(input));
    seen.inits.push(init ?? {});
    return Promise.resolve(reply(String(input)));
  }) as typeof fetch;
  console.warn = (...a: unknown[]) => { seen.warnings.push(a.join(' ')); };
  try {
    await body(seen);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    resetTraderCache();
  }
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** A trader_accounts table that honours the cursor and the limit, as PostgREST does.
 *  Ids come back as stored (the case they were given in); the order is by lower case. */
const table = (...stored: string[]) => (url: string) => {
  const q = new URL(url).searchParams;
  const after = q.get('profile_id')?.replace('gt.', '').toLowerCase() ?? '';
  return ok(
    [...stored].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
      .filter((id) => id.toLowerCase() > after)
      .slice(0, Number(q.get('limit') ?? 1000))
      .map((profile_id) => ({ profile_id })));
};

Deno.test('trader list: asks for the ids of verified traders only, in order, with no cursor on the first page', async () => {
  await withNetwork(() => ok([]), async (seen) => {
    assertEquals(await fetchTraderIds(env, T0), new Set());
    assertEquals(seen.calls.length, 1);
    const url = new URL(seen.calls[0]);
    assertEquals(url.origin + url.pathname, 'https://db.example.co/rest/v1/trader_accounts');
    assertEquals(url.searchParams.get('select'), 'profile_id');
    assertEquals(url.searchParams.get('status'), 'eq.verified');
    assertEquals(url.searchParams.get('order'), 'profile_id.asc');
    assertEquals(url.searchParams.get('limit'), '1000');
    assertFalse(url.searchParams.has('profile_id'), 'the first page has no cursor');
    // The same headers as every other read: anon key, markety schema, a plain GET.
    const init = seen.inits[0];
    assertEquals(init.method ?? 'GET', 'GET');
    const headers = init.headers as Record<string, string>;
    assertEquals(headers['Accept-Profile'], 'markety');
    assertEquals(headers.apikey, 'anon-key');
  });
});

Deno.test('trader list: pages by keyset until a page is EMPTY, never until one is short', async () => {
  const pages: Record<string, string[]> = {
    '': [idN(1), idN(2)], // short of 1000, yet not the end: PostgREST may cap a response below the limit
    [idN(2)]: [idN(3)],
    [idN(3)]: [],
  };
  await withNetwork((url) => {
    const after = new URL(url).searchParams.get('profile_id')?.replace('gt.', '') ?? '';
    return ok((pages[after] ?? []).map((profile_id) => ({ profile_id })));
  }, async (seen) => {
    assertEquals(await fetchTraderIds(env, T0), new Set([idN(1), idN(2), idN(3)]));
    assertEquals(seen.calls.length, 3, 'a short page was taken for the last one');
    assertStringIncludes(seen.calls[1], `profile_id=gt.${idN(2)}`);
    assertStringIncludes(seen.calls[2], `profile_id=gt.${idN(3)}`);
  });
});

Deno.test('trader list: ids are lower-cased, because the lookup key is', async () => {
  await withNetwork(table(ID.toUpperCase()), async () => {
    assertEquals(await fetchTraderIds(env, T0), new Set([ID]));
  });
});

Deno.test('trader list: one row that is not a canonical id fails the whole read', async () => {
  const bad: unknown[] = [
    { profile_id: 'not-a-uuid' }, { profile_id: `${ID}&select=*` }, { profile_id: null },
    { profile_id: 42 }, {}, null, 'x', [],
  ];
  for (const row of bad) {
    resetTraderCache();
    // The page after the bad one is empty, as a real server's would be: the read must
    // fail on the row itself, not on the cursor failing to move.
    const reply = (url: string) =>
      ok(url.includes('profile_id=gt.') ? [] : [{ profile_id: idN(1) }, row]);
    await withNetwork(reply, async () => {
      assertEquals(await fetchTraderIds(env, T0), null, `accepted ${JSON.stringify(row)}`);
    });
  }
});

Deno.test('trader list: a failed read is null, and so is anything that is not a list', async () => {
  const replies: [string, () => Response | Promise<Response>][] = [
    ['500', () => new Response('{}', { status: 500 })],
    ['401', () => new Response('{}', { status: 401 })],
    ['an object', () => ok({ message: 'nope' })],
    ['null', () => ok(null)],
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['a network error', () => Promise.reject(new Error('network'))],
  ];
  for (const [what, reply] of replies) {
    await withNetwork(reply, async () => {
      assertEquals(await fetchTraderIds(env, T0), null, what);
    });
  }
});

Deno.test('trader list: a cursor the server ignores fails the read instead of looping', async () => {
  await withNetwork(() => ok([{ profile_id: idN(1) }]), async (seen) => {
    assertEquals(await fetchTraderIds(env, T0), null);
    assertEquals(seen.calls.length, 2, 'the same page was fetched again and again');
  });
});

Deno.test('trader list: more pages than any deployment is a failed read, not a partial list', async () => {
  await withNetwork((url) => {
    const after = new URL(url).searchParams.get('profile_id')?.replace('gt.', '');
    const n = after ? parseInt(after.slice(-12), 16) : 0;
    return ok([{ profile_id: idN(n + 1) }]);
  }, async (seen) => {
    assertEquals(await fetchTraderIds(env, T0), null);
    assertEquals(seen.calls.length, 200);
  });
});

Deno.test('trader list: fresh for a minute, read again after', async () => {
  await withNetwork(table(idN(1)), async (seen) => {
    await fetchTraderIds(env, T0);
    await fetchTraderIds(env, T0 + 59_999);
    assertEquals(firstPages(seen.calls).length, 1);
    await fetchTraderIds(env, T0 + 60_000);
    assertEquals(firstPages(seen.calls).length, 2);
  });
});

Deno.test('trader list: after a failure the old list stands in for fifteen minutes, then it is dropped', async () => {
  let up = true;
  await withNetwork((url) => (up ? table(idN(1))(url) : new Response('{}', { status: 503 })),
    async (seen) => {
      const good = await fetchTraderIds(env, T0);
      assertEquals(good, new Set([idN(1)]));
      up = false;
      assertEquals(await fetchTraderIds(env, T0 + 60_000), good, 'a minute on, read failing');
      assertEquals(await fetchTraderIds(env, T0 + 15 * 60_000 - 1), good, 'just under fifteen minutes');
      assertEquals(seen.warnings, [], 'warned although a usable list was in hand');
      assertEquals(await fetchTraderIds(env, T0 + 15 * 60_000), null, 'fifteen minutes');
      assertEquals(seen.warnings.length, 1);
      // And it recovers on the very next call.
      up = true;
      assertEquals(await fetchTraderIds(env, T0 + 15 * 60_000 + 1), new Set([idN(1)]));
    });
});

Deno.test('trader list: a failure is not cached, and is reported once a minute, not once a request', async () => {
  let up = false;
  await withNetwork((url) => (up ? table(idN(1))(url) : new Response('{}', { status: 500 })),
    async (seen) => {
      assertEquals(await fetchTraderIds(env, T0 + 100_000), null);
      assertEquals(await fetchTraderIds(env, T0 + 101_000), null);
      assertEquals(await fetchTraderIds(env, T0 + 159_999), null);
      assertEquals(seen.warnings.length, 1);
      assertEquals(firstPages(seen.calls).length, 3, 'a failed read must be retried, not remembered');
      assertEquals(await fetchTraderIds(env, T0 + 160_001), null);
      assertEquals(seen.warnings.length, 2);
      up = true;
      assertEquals(await fetchTraderIds(env, T0 + 161_000), new Set([idN(1)]));
    });
});

Deno.test('trader list: concurrent callers share one read', async () => {
  await withNetwork(table(idN(1)), async (seen) => {
    const all = await Promise.all([1, 2, 3, 4].map(() => fetchTraderIds(env, T0)));
    for (const set of all) assertEquals(set, new Set([idN(1)]));
    assertEquals(firstPages(seen.calls).length, 1);
  });
});

Deno.test('trader list: nothing is requested, and nothing is said, when no database is configured', async () => {
  await withNetwork(() => ok([]), async (seen) => {
    assertEquals(await fetchTraderIds({ url: '', anon: '' }, T0), null);
    assertEquals(await fetchTraderIds({ url: 'https://db.example.co', anon: '' }, T0 + 120_000), null);
    assertEquals(seen.calls, []);
    assertEquals(seen.warnings, []);
  });
});

const fullShopRow = {
  business_name: 'Marlowe & Daughters', display_name: 'Marlowe', city: 'Hounslow',
  hours_today: [['09:00', '12:30']], open_now: true, listings_live: 3,
  // What the real function also returns, and a page must never see.
  company_number: '08765432', pub_lat: 51.4684, pub_lng: -0.3616, address: '1 High St',
  rating: 4.7, rating_count: 213, sales_count: 1999, profile_id: ID,
};

Deno.test('shop front: one read, by id, and only the fields a page may use come out', async () => {
  await withNetwork(() => ok([fullShopRow]), async (seen) => {
    const shop = await fetchShop(env, ID);
    assertEquals(shop, {
      business_name: 'Marlowe & Daughters', display_name: 'Marlowe', city: 'Hounslow',
      hours_today: [['09:00', '12:30']], open_now: true, listings_live: 3,
    });
    assertEquals(seen.calls, [`https://db.example.co/rest/v1/rpc/shop_front?p_trader=${ID}`]);
    assertEquals(seen.inits[0].method ?? 'GET', 'GET');
  });
});

Deno.test('shop front: a value of the wrong type becomes null, an empty answer is null', async () => {
  await withNetwork(() => ok([{
    business_name: 42, display_name: ['x'], city: {}, hours_today: 'always', open_now: 'yes',
    listings_live: '3',
  }]), async () => {
    assertEquals(await fetchShop(env, ID), {
      business_name: null, display_name: null, city: null, hours_today: 'always', open_now: null,
      listings_live: null,
    });
  });
  for (const reply of [() => ok([]), () => ok({}), () => ok(null), () => ok(['x']),
    () => new Response('{}', { status: 500 }), () => Promise.reject(new Error('network'))]) {
    await withNetwork(reply, async () => { assertEquals(await fetchShop(env, ID), null); });
  }
});

Deno.test('shop front: the uuid gate holds here too', async () => {
  await withNetwork(() => ok([fullShopRow]), async (seen) => {
    assertEquals(await fetchShop(env, `${ID}&select=*`), null);
    assertEquals(await fetchShop(env, '../x'), null);
    assertEquals(await fetchShop(env, ''), null);
    assertEquals(await fetchShop({ url: '', anon: '' }, ID), null);
    assertEquals(seen.calls, []);
  });
});

Deno.test('every listing read selects seller_id, which shop mode is decided from', async () => {
  await withNetwork((url) => ok(url.includes('profiles?') ? [{ id: ID }] : []), async (seen) => {
    await fetchListing(env, ID);
    await fetchSeller(env, ID);
    await fetchZoneListings(env, 'hounslow');
    const listingReads = seen.calls.filter((c) => c.includes('/listings?'));
    assertEquals(listingReads.length, 3);
    for (const c of listingReads) {
      const select = new URL(c).searchParams.get('select') ?? '';
      assert(select.split(',').includes('seller_id'), `no seller_id in ${select}`);
    }
    const sellerListings = new URL(listingReads[1]);
    assertEquals(sellerListings.searchParams.get('limit'), '40');
  });
});

Deno.test('the category list is read once an hour, and a failed read neither empties nor poisons it', async () => {
  resetCatalogCache();
  let ok = true;
  const f = stubFetch(() => ok ? { body: [{ id: 'furniture', name: 'Furniture', emoji: null }] } : { ok: false });
  try {
    // Nothing cached and the read fails: unknown (null), not "no categories".
    ok = false;
    assertEquals(await fetchCategories(env, 0), null);
    ok = true;
    assertEquals((await fetchCategories(env, 1))?.map((c) => c.id), ['furniture']);
    assertEquals(f.calls.length, 2);
    // Within the hour: no more reads.
    await fetchCategories(env, 30 * 60 * 1000);
    assertEquals(f.calls.length, 2);
    // Past the hour with the database down: the old list stands.
    ok = false;
    assertEquals((await fetchCategories(env, 61 * 60 * 1000))?.map((c) => c.id), ['furniture']);
    assertEquals(f.calls.length, 3);
  } finally { f.restore(); resetCatalogCache(); }
});
