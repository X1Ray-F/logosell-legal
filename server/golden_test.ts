/**
 * Pages that must not change by accident.
 *
 * server/golden/ holds the exact bytes of every page the renderer produces for a
 * fixed set of inputs (golden_cases.ts, fixtures.ts). The ten person-to-person
 * files (no `shop-` prefix) were written from the renderer as it stood BEFORE shop
 * mode existed, so this file is the regression test for "a private seller's page
 * is exactly what it was": adding shop mode may not alter one byte of them.
 *
 * Two layers, because the renderer and the router can each break that promise:
 *
 *   1. render: the renderer's output for each case equals its file;
 *   2. route:  the router, given the same data and a seller who is not a trader,
 *      answers with those same bytes.
 *
 * If a person-to-person page is MEANT to change: `deno task golden`, read the diff
 * of server/golden/ (that diff is the review), and commit it with the change.
 * A change to shop mode must leave every person-to-person file untouched.
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { type Deps, handle } from './app.ts';
import { GOLDEN_CASES } from './golden_cases.ts';
import * as f from './fixtures.ts';
import type { Listing } from './render.ts';

const dir = new URL('./golden/', import.meta.url);
const golden = (name: string) => Deno.readTextFile(new URL(name, dir));
const isShop = (name: string) => name.startsWith('shop-');

function firstDifference(got: string, want: string): string {
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i++;
  const line = want.slice(0, i).split('\n').length;
  return `line ${line}: got ${JSON.stringify(got.slice(i, i + 70))}, ` +
    `golden has ${JSON.stringify(want.slice(i, i + 70))}`;
}

function assertSame(got: string, want: string, what: string) {
  assert(
    got === want,
    `${what} no longer matches its golden file (${firstDifference(got, want)}). ` +
      'If this change is intended, run `deno task golden` and review the diff.',
  );
}

Deno.test('the golden files are exactly the cases: none missing, none left over', async () => {
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) files.push(e.name);
  assertEquals(files.sort(), Object.keys(GOLDEN_CASES).sort());
});

Deno.test('person-to-person pages render byte for byte as they did before shop mode', async () => {
  const names = Object.keys(GOLDEN_CASES).filter((n) => !isShop(n));
  assert(names.length >= 10, 'the person-to-person set shrank');
  for (const name of names) assertSame(GOLDEN_CASES[name](), await golden(name), name);
});

Deno.test('shop pages render as their snapshots', async () => {
  const names = Object.keys(GOLDEN_CASES).filter(isShop);
  assert(names.length > 0);
  for (const name of names) assertSame(GOLDEN_CASES[name](), await golden(name), name);
});

/* ── Through the router ──────────────────────────────────────────────────────────────────── */

function deps(over: Partial<Deps> = {}): Deps {
  return {
    env: { url: 'https://db.example.co', anon: 'anon-key' },
    serveStatic: () => Promise.resolve(new Response('static')),
    fetchListing: (_e, id) =>
      Promise.resolve(
        [f.listingFull, f.listingCityOnly, f.listingBare]
          .find((l) => l.id === id) ?? null,
      ),
    fetchSeller: (_e, id) =>
      Promise.resolve(
        id === f.SELLER_ID
          ? { seller: f.priya, listings: [f.listingFull, f.listingCityOnly] }
          : id === f.SELLER_ID_2
          ? { seller: f.sam, listings: [] }
          : null,
      ),
    fetchPublicListings: () => Promise.resolve([]),
    fetchZone: (_e, slug) => Promise.resolve(slug === 'hounslow' ? f.hounslow : null),
    fetchZoneListings: () => Promise.resolve([f.listingFull, f.listingCityOnly]),
    fetchZoneCategories: () => Promise.resolve(f.categories),
    // Nobody in this data is a verified trader.
    fetchTraders: () => Promise.resolve(new Set<string>()),
    fetchShop: () => Promise.resolve(null),
    ...over,
  };
}

async function body(path: string, d: Deps = deps()): Promise<string> {
  const res = await handle(new Request(`https://logosell.app${path}`), d);
  return await res.text();
}

Deno.test("route: a private seller's listing page is the golden page", async () => {
  assertSame(
    await body(`/listing/${f.LISTING_ID}`),
    await golden('listing-full.html'),
    'listing-full',
  );
  assertSame(
    await body(`/listing/${f.LISTING_ID_2}`),
    await golden('listing-city.html'),
    'listing-city',
  );
});

Deno.test("route: a private seller's page is the golden page", async () => {
  assertSame(
    await body(`/seller/${f.SELLER_ID}`),
    await golden('seller-rated.html'),
    'seller-rated',
  );
  assertSame(
    await body(`/seller/${f.SELLER_ID_2}`),
    await golden('seller-empty.html'),
    'seller-empty',
  );
});

Deno.test('route: zone pages of private sellers are the golden pages', async () => {
  assertSame(
    await body('/hounslow/furniture'),
    await golden('zone-category.html'),
    'zone-category',
  );
  const empty = deps({
    fetchZoneListings: () => Promise.resolve([]),
    fetchZoneCategories: () => Promise.resolve([]),
  });
  assertSame(await body('/hounslow', empty), await golden('zone-empty.html'), 'zone-empty');
});

Deno.test('route: an unknown listing is the golden "unavailable" page', async () => {
  assertSame(await body('/listing/not-a-uuid'), await golden('unavailable.html'), 'unavailable');
});

Deno.test('route: the one deliberate difference in the zone page is the listing with no known seller', async () => {
  // listingBare has no seller, so shop mode will not print its price: it is shown as
  // "Ask in store". Every other byte of zone.html must be as it was.
  const d = deps({ fetchZoneListings: () => Promise.resolve(f.zoneListings as Listing[]) });
  const got = await body('/hounslow', d);
  const want = (await golden('zone.html'))
    .replace('<div class="muted">£0</div>', '<div class="muted">Ask in store</div>');
  assert(want !== await golden('zone.html'), 'the replacement did not apply: the fixture changed');
  assertSame(got, want, 'zone with an unknown-seller listing');
});
