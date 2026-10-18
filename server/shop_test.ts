/**
 * Shop mode: a verified trader's pages carry no price, anywhere.
 *
 * THESE TESTS ARE A LEGAL OBLIGATION, NOT A PREFERENCE. The reading behind shop mode
 * is that a page showing a product with NO price is probably not an "invitation to
 * purchase" (Digital Markets, Competition and Consumers Act 2024 s.230(10); CMA207
 * 4.11), while the same page WITH a price probably is, and Logosell would then be
 * publishing a trader's invitation to purchase without the trader's information
 * duties met. The absence of a price is the whole point of the mode. If a test in this
 * file fails, the page is wrong, not the test: find the price and take it out.
 * Loosening a check here needs the same sign-off as the legal reading itself.
 *
 * What is held, and where:
 *
 *   1. the detector (priceLeaks) and proof that it is not blind;
 *   2. the redaction of prices a shop typed into its own text (withoutPrices);
 *   3. the renderers, over every shop front and every spelling of a price;
 *   4. the router: which seller gets which page, and FAIL CLOSED, meaning that when
 *      "is this seller a trader?" cannot be answered, the answer is a 404 and never
 *      a page with a price;
 *   5. the same through the real data layer, with only the network replaced;
 *   6. the committed snapshots in server/golden/.
 *
 * That a PRIVATE seller's pages stay exactly as they were is golden_test.ts.
 */
import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@1';
import { type Deps, handle } from './app.ts';
import { resetTraderCache } from './data.ts';
import {
  CSS,
  type Listing,
  listingPage,
  type Seller,
  sellerIdOf,
  sellerPage,
  SHOP_NOTE,
  type ShopFront,
  shopHours,
  shopListingPage,
  shopSellerPage,
  sitemap,
  unavailablePage,
  withoutPrices,
  zonePage,
} from './render.ts';
import * as f from './fixtures.ts';

/* ── 1. The detector ──────────────────────────────────────────────────────────────────────── */

const FIXTURE_PRICES = new RegExp(
  `(?<![0-9A-Za-z])(?:${f.SHOP_PRICE}|4,871|5230|5,230)(?![0-9A-Za-z])`,
);

/** What makes a page a price page. Each rule has a name so a failure says what it saw. */
const PRICE_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['currency sign', /\p{Sc}/u],
  [
    'currency entity',
    /&(?:amp;)?(?:#0*(?:163|8364|36|165|162)|#x0*(?:a3|20ac|24|a5|a2)|pound|euro|dollar|yen|cent|curren);/i,
  ],
  [
    'amount with currency word',
    /\d[\d,.]*\s*(?:gbp|eur|usd|pounds?|quid|euros?|dollars?|bucks)\b|\b(?:gbp|eur|usd)\s*\d/i,
  ],
  ['currency code', /\b(?:GBP|EUR|USD)\b/],
  ['product:price meta', /product:price/i],
  [
    'structured price',
    /"(?:price|priceCurrency|priceSpecification|lowPrice|highPrice|priceValidUntil)"\s*:/,
  ],
  [
    'structured offer',
    /"@type"\s*:\s*"(?:Aggregate)?Offer"|"offers"\s*:|schema\.org\/(?:Aggregate)?Offer\b/,
  ],
  ['structured product', /"@type"\s*:\s*"Product"/],
  ['price element', /class="[^"]*\bprice\b|itemprop="[^"]*price/i],
  ['the fixture price', FIXTURE_PRICES],
];

/** What a shop page leaves out besides the price: ratings, sales counts. (The address is
 *  not here: the renderer is never given one, see the test that hands it one anyway.) */
const EXTRA_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['rating star', /★/],
  ['rating or review word', /\b(?:ratings?|rated|reviews?)\b/i],
  ['"N sold" or "N sales"', /\d[\d,]*\s+(?:sold|sales)\b/i],
  [
    'the fixture rating or sales count',
    new RegExp(
      `(?<![0-9A-Za-z.])(?:${f.SHOP_RATING}|${f.SHOP_RATING_COUNT}|${f.SHOP_SALES})(?![0-9A-Za-z])`,
    ),
  ],
];

const STYLE_BLOCK = /<style>[\s\S]*?<\/style>/g;

function scan(page: string, rules: ReadonlyArray<readonly [string, RegExp]>): string[] {
  // The stylesheet defines `.price` for the person-to-person pages. It is not content.
  const text = page.replace(STYLE_BLOCK, '');
  return rules.filter(([, re]) => re.test(text)).map(([name]) => name);
}
const priceLeaks = (page: string) => scan(page, PRICE_RULES);
const extraLeaks = (page: string) => scan(page, EXTRA_RULES);

function assertShopPage(page: string, what: string) {
  assertEquals(priceLeaks(page), [], `${what}: a shop page shows a price`);
  assertEquals(extraLeaks(page), [], `${what}: a shop page shows a rating or a sales count`);
  assertFalse(page.includes('application/ld+json'), `${what}: a shop page has structured data`);
  assertFalse(/<script/i.test(page), `${what}: a shop page has a script`);
}

Deno.test('the detector is not blind: it flags a person-to-person page of the same stock', () => {
  const p2p = listingPage({ id: f.SHOP_LISTING_ID, listing: f.shopListing, origin: f.ORIGIN });
  const found = priceLeaks(p2p);
  for (const [name] of PRICE_RULES) {
    // These three need text a real page does not have; the next test covers them.
    if (['currency entity', 'amount with currency word', 'currency word'].includes(name)) continue;
    assert(
      found.includes(name),
      `the detector missed "${name}" on a page that has a price (it saw: ${found.join(', ')})`,
    );
  }
  const seller = sellerPage({
    id: f.TRADER_ID,
    seller: f.marlowe,
    listings: f.shopStock,
    origin: f.ORIGIN,
  });
  assert(priceLeaks(seller).includes('currency sign'), 'missed the price on a seller page');
  assert(extraLeaks(seller).includes('rating star'), 'missed the rating on a seller page');
  const zone = zonePage({
    zone: f.hounslow,
    listings: f.shopStock,
    categories: f.categories,
    origin: f.ORIGIN,
  });
  assert(priceLeaks(zone).includes('currency sign'), 'missed the price in a zone row');
});

Deno.test('the detector sees each form of price on its own', () => {
  const samples: [string, string][] = [
    ['<p>&pound;5</p>', 'currency entity'],
    ['<p>&amp;pound;5</p>', 'currency entity'],
    ['<p>&#xA3;5</p>', 'currency entity'],
    ['<p>&#163;5</p>', 'currency entity'],
    ['<p>20 quid</p>', 'amount with currency word'],
    ['<p>20 pounds</p>', 'amount with currency word'],
    ['<p>GBP 20</p>', 'amount with currency word'],
    ['<p>GBP</p>', 'currency code'],
    ['<p>€5</p>', 'currency sign'],
    ['<meta property="product:price:amount" content="5">', 'product:price meta'],
    ['<script type="application/ld+json">{"price":5}</script>', 'structured price'],
    ['<script type="application/ld+json">{"offers":{}}</script>', 'structured offer'],
    ['<script type="application/ld+json">{"@type":"Offer"}</script>', 'structured offer'],
    ['<script type="application/ld+json">{"@type":"Product"}</script>', 'structured product'],
    ['<div class="price">x</div>', 'price element'],
    ['<span itemprop="price">x</span>', 'price element'],
    ['<p>Table 4871</p>', 'the fixture price'],
    ['<p>Table 5,230</p>', 'the fixture price'],
  ];
  for (const [sample, rule] of samples) {
    assert(priceLeaks(sample).includes(rule), `${rule} not seen in ${sample}`);
  }
  const extras: [string, string][] = [
    ['<p>4.7★ (213)</p>', 'rating star'],
    ['<p>Rated 5 by buyers</p>', 'rating or review word'],
    ['<p>1,999 sold</p>', '"N sold" or "N sales"'],
    ['<p>213 sales</p>', '"N sold" or "N sales"'],
    ['<p>(213)</p>', 'the fixture rating or sales count'],
  ];
  for (const [sample, rule] of extras) {
    assert(extraLeaks(sample).includes(rule), `${rule} not seen in ${sample}`);
  }
});

Deno.test('the detector ignores the stylesheet and stays quiet on pages with nothing to find', () => {
  assertStringIncludes(CSS, '.price', 'precondition: the stylesheet defines .price');
  assertEquals(priceLeaks('<style>.price{color:red}</style><p>hello</p>'), []);
  assertEquals(priceLeaks(unavailablePage(f.ORIGIN)), []);
  assertEquals(priceLeaks(sitemap({ origin: f.ORIGIN, ...f.sitemapInput })), []);
  assertEquals(extraLeaks(unavailablePage(f.ORIGIN)), []);
});

/* ── 2. What a shop typed ─────────────────────────────────────────────────────────────────── */

const ZWSP = String.fromCharCode(0x200b);
const ZWNJ = String.fromCharCode(0x200c);
const ZWJ = String.fromCharCode(0x200d);
const WORD_JOINER = String.fromCharCode(0x2060);
const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0xa0);
const NARROW_NBSP = String.fromCharCode(0x202f);
const FULLWIDTH_POUND = String.fromCharCode(0xffe1);
const fullwidth = (digits: string) =>
  digits.replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d)));

Deno.test('withoutPrices: the usual ways of typing a price are taken out, the rest stays', () => {
  const cases: [string, string][] = [
    ['Teak sideboard £4,871 ono', 'Teak sideboard ono'],
    ['£120', ''],
    ['Now £99.99!', 'Now!'],
    ['4871 GBP', ''],
    ['GBP 4871', ''],
    ['4,871 pounds', ''],
    ['15 quid', ''],
    ['&pound;120', ''],
    ['&#163;120', ''],
    ['&#xA3;120', ''],
    ['$20 or €20', 'or'],
    ['only £5 each, 3 for £12', 'only each, 3 for'],
    ['Price: £120 (negotiable)', 'Price: (negotiable)'],
    ['(£120)', ''],
    ['was £5,230, now £4,871.', 'was now.'],
    ['Size 12, £', 'Size 12'],
    ['Table, £120, good', 'Table, good'],
    ['Sale! £120 | Table', 'Sale! | Table'],
    ['£4 871', ''],
    ['£120k', ''],
    ['EUR 100', ''],
  ];
  for (const [input, want] of cases) {
    assertEquals(withoutPrices(input), want, `withoutPrices(${JSON.stringify(input)})`);
    assertEquals(
      withoutPrices(withoutPrices(input)),
      want,
      `not idempotent on ${JSON.stringify(input)}`,
    );
  }
});

Deno.test('withoutPrices: text with no price comes back untouched, byte for byte', () => {
  for (
    const text of [
      'Oak table 120cm',
      'Seats six',
      '',
      'Mid-century, 1960s',
      'Size 12',
      '3 drawers',
      "Kid's bike",
      'Open 9-5',
      '2 for 1',
      '24/7',
      'A4 paper',
      'Pound Lane shop',
      'GBP',
      'pounds',
      'Marlowe & Daughters',
      '<b>bold</b>',
      'Café ñ 日本語',
      '  leading and trailing  ',
      'R&Central',
      'AT&T',
      '&pound 120',
    ]
  ) assertEquals(withoutPrices(text), text);
  assertEquals(withoutPrices(null), '');
  assertEquals(withoutPrices(undefined), '');
});

Deno.test('withoutPrices: every currency sign, gap and amount, including the disguised ones', () => {
  const signs = [
    '£',
    '$',
    '€',
    '¥',
    '₹',
    '₽',
    '₤',
    '₩',
    FULLWIDTH_POUND,
    String.fromCharCode(0xff04),
    String.fromCharCode(0xfe69),
    String.fromCharCode(0x0e3f),
    String.fromCharCode(0x20bf),
  ];
  const gaps = [
    '',
    ' ',
    '  ',
    '\t',
    NBSP,
    NARROW_NBSP,
    ZWSP,
    ZWNJ,
    ZWJ,
    WORD_JOINER,
    BOM,
    ` ${ZWSP} `,
  ];
  const amounts = [
    '120',
    '1,250',
    '4871.50',
    '0.99',
    '4 871',
    '1,250,000',
    fullwidth('120'),
    fullwidth('4871'),
  ];
  let n = 0;
  for (const sign of signs) {
    for (const gap of gaps) {
      for (const amount of amounts) {
        const typed = `${sign}${gap}${amount}`;
        const got = withoutPrices(`Teak sideboard ${typed} ono`);
        assertEquals(got, 'Teak sideboard ono', `${JSON.stringify(typed)} was not taken out`);
        n++;
      }
    }
  }
  assert(n > 1000, 'the sweep shrank');
  // The amount first, then a word for the currency.
  for (const amount of ['120', '1,250', '4 871', '4871.50', fullwidth('4871')]) {
    for (
      const word of ['GBP', 'gbp', 'pounds', 'Pound', 'quid', 'EUR', 'euros', 'dollars', 'bucks']
    ) {
      for (const gap of ['', ' ', NBSP, ZWSP]) {
        const typed = `${amount}${gap}${word}`;
        assertEquals(withoutPrices(`Teak ${typed} ono`), 'Teak ono', `${JSON.stringify(typed)}`);
      }
    }
  }
});

Deno.test('withoutPrices: hostile input is cut short, not chewed on', () => {
  // The bound itself, on text that costs nothing to scan. Without it the loop below does
  // not fail, it runs for minutes (a synchronous regex cannot be interrupted), so the
  // bound is asserted first, where a missing one shows up as a failure and not as a hang.
  assertEquals(withoutPrices('a'.repeat(10_000)).length, 4000);
  assertEquals(withoutPrices('a'.repeat(3_999)), 'a'.repeat(3_999));
  const started = performance.now();
  for (
    const text of [
      '1'.repeat(1_000_000),
      '1,'.repeat(500_000),
      '1 111 '.repeat(200_000),
      ('£' + '9'.repeat(50) + ' ').repeat(100_000),
      ' '.repeat(1_000_000) + '£1',
    ]
  ) assert(withoutPrices(text).length <= 4000);
  // A generous bound: this is about "does not take minutes", not about speed.
  assert(performance.now() - started < 5000, 'withoutPrices is slow on long hostile input');
});

Deno.test('shopHours says only what the database said, and drops what it cannot trust', () => {
  const cases: [ShopFront | null | undefined, string | null][] = [
    [null, null],
    [undefined, null],
    [{}, null],
    [{ hours_today: null }, null],
    [{ hours_today: null, open_now: false }, null],
    [{ hours_today: [] }, 'Closed today'],
    [{ hours_today: [], open_now: false }, 'Closed today'],
    [{ hours_today: [['09:00', '17:30']], open_now: true }, 'Open now · Today 09:00–17:30'],
    [
      { hours_today: [['09:00', '12:00'], ['13:00', '17:30']], open_now: false },
      'Closed now · Today 09:00–12:00, 13:00–17:30',
    ],
    [{ hours_today: [['09:00', '17:30']] }, 'Today 09:00–17:30'],
    [{ hours_today: [['9:00', '17:30']], open_now: true }, null],
    [{ hours_today: [['09:00', '17:30'], 'x'] }, null],
    [{ hours_today: 'always' }, null],
    [{ hours_today: [['09:00', '<script>']], open_now: true }, null],
    [{ hours_today: [['24:00', '25:00']], open_now: true }, null],
    [{ hours_today: { 0: ['09:00', '17:30'] } }, null],
  ];
  for (const [shop, want] of cases) {
    assertEquals(shopHours(shop), want, `shopHours(${JSON.stringify(shop)})`);
  }
});

Deno.test('sellerIdOf reads the column first, lower-cases it, and says null when it cannot tell', () => {
  const base = { id: 'x', title: 't', price_gbp: 1 };
  assertEquals(sellerIdOf({ ...base, seller_id: f.TRADER_ID }), f.TRADER_ID);
  assertEquals(sellerIdOf({ ...base, seller_id: f.TRADER_ID.toUpperCase() }), f.TRADER_ID);
  assertEquals(sellerIdOf({ ...base, seller: { id: f.TRADER_ID.toUpperCase() } }), f.TRADER_ID);
  // The column wins over the embedded profile.
  assertEquals(
    sellerIdOf({ ...base, seller_id: f.TRADER_ID, seller: { id: f.SELLER_ID } }),
    f.TRADER_ID,
  );
  assertEquals(sellerIdOf(base), null);
  assertEquals(sellerIdOf({ ...base, seller: null }), null);
  assertEquals(sellerIdOf({ ...base, seller_id: '' }), null);
  assertEquals(sellerIdOf({ ...base, seller_id: 42 as unknown as string }), null);
});

/* ── 3. The renderers ─────────────────────────────────────────────────────────────────────── */

const SHOP_FRONTS: [string, ShopFront | null | undefined][] = [
  ['open', f.marloweShop],
  ['closed', f.marloweShopClosed],
  ['no hours', f.marloweShopNoHours],
  ['closed today', f.marloweShopClosedToday],
  ['hostile names', f.marloweShopHostile],
  ['shop front unreadable', null],
  ['shop front not asked for', undefined],
];

const listingPageOf = (l: Listing, shop?: ShopFront | null) =>
  shopListingPage({ id: l.id, listing: l, origin: f.ORIGIN, shop });
const sellerPageOf = (listings: Listing[], shop?: ShopFront | null, seller = f.marlowe) =>
  shopSellerPage({ id: f.TRADER_ID, seller, listings, origin: f.ORIGIN, shop });

Deno.test('a shop listing page shows no price, whatever the stock and the shop front', () => {
  for (const l of [f.shopListing, f.shopListingHostile, f.shopListingPriceOnly]) {
    for (const [label, shop] of SHOP_FRONTS) {
      assertShopPage(listingPageOf(l, shop), `listing "${l.title}" with shop front ${label}`);
    }
  }
});

Deno.test('a shop page shows no price, rating or sales count, whatever the stock and the shop front', () => {
  for (const [label, shop] of SHOP_FRONTS) {
    for (
      const [stock, listings] of [
        ['no stock', []],
        ['clean and hostile stock', f.shopStock],
        ['one piece', [f.shopListing]],
      ] as [string, Listing[]][]
    ) {
      assertShopPage(sellerPageOf(listings, shop), `shop page, ${stock}, shop front ${label}`);
    }
  }
});

Deno.test("a zone page lists a shop's pieces without a price, and structured data without one", () => {
  const traders = new Set([f.TRADER_ID]);
  for (const listings of [f.shopStock, [f.shopListingPriceOnly], [f.shopListingHostile]]) {
    const page = zonePage({
      zone: f.hounslow,
      listings,
      categories: f.categories,
      origin: f.ORIGIN,
      traders,
    });
    assertEquals(priceLeaks(page), [], 'a zone page of shop stock shows a price');
    assertEquals(extraLeaks(page), []);
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page)?.[1];
    assert(ld, 'the zone page lost its ItemList');
    const data = JSON.parse(ld);
    assertEquals(data['@type'], 'ItemList');
    for (const item of data.itemListElement) {
      assertEquals(Object.keys(item).sort(), ['@type', 'name', 'position', 'url']);
    }
  }
});

/** Every way a price gets typed, each with the digits of f.SHOP_PRICE in it. */
const SPELLINGS: string[] = [
  '£4871',
  '£4,871',
  '£4,871.00',
  '£ 4871',
  `£${NBSP}4871`,
  `£${ZWSP}4871`,
  `${FULLWIDTH_POUND}${fullwidth('4871')}`,
  '£4 871',
  '£4.9k',
  '£4871+',
  '4871 GBP',
  '4871GBP',
  'GBP 4871',
  'GBP4871',
  '4,871 pounds',
  '4871 pound',
  '4871 quid',
  '4871 Quid',
  '&pound;4871',
  '&#163;4871',
  '&#xA3;4871',
  '&#x00A3;4871',
  '&pound; 4871',
  '&amp;pound;4871',
  '$4871',
  '€4871',
  '¥4871',
  'USD 4871',
  '4871 euros',
  '4871 bucks',
  '£4871-£5230',
  'from £4,871',
];

Deno.test('a price typed into any text a shop controls is gone from the page, in every spelling', () => {
  for (const typed of SPELLINGS) {
    const where = (field: string) => `"${typed}" in ${field}`;
    const hostile: [string, Listing, ShopFront][] = [
      ['title', { ...f.shopListing, title: `Teak sideboard ${typed} ono` }, f.marloweShop],
      [
        'description',
        { ...f.shopListing, description: `Was ${typed}. Collect Thursday.` },
        f.marloweShop,
      ],
      [
        'listing city',
        { ...f.shopListing, city: `Hounslow ${typed}`, zone_slug: null },
        f.marloweShop,
      ],
      ['seller name', {
        ...f.shopListing,
        seller: { ...f.marlowe, display_name: `Marlowe ${typed}` },
      }, {}],
      ['business name', f.shopListing, { ...f.marloweShop, business_name: `Marlowe ${typed}` }],
      ['profile name', f.shopListing, {
        ...f.marloweShop,
        business_name: null,
        display_name: typed,
      }],
      ['shop city', f.shopListing, { ...f.marloweShop, city: `Hounslow ${typed}` }],
    ];
    for (const [field, listing, shop] of hostile) {
      assertShopPage(listingPageOf(listing, shop), `listing page, ${where(field)}`);
      assertShopPage(
        sellerPageOf([listing], shop, listing.seller ?? f.marlowe),
        `shop page, ${where(field)}`,
      );
    }
    const zone = zonePage({
      zone: f.hounslow,
      categories: f.categories,
      origin: f.ORIGIN,
      traders: new Set([f.TRADER_ID]),
      listings: [{ ...f.shopListing, title: `Teak ${typed}`, city: `Hounslow ${typed}` }],
    });
    assertEquals(priceLeaks(zone), [], `zone row, ${where('title and city')}`);
  }
});

Deno.test('a price that sits across the 200th character is taken out before the text is cut', () => {
  // Cut first and a "£4871" straddling the limit would leave "£48" behind.
  for (const pad of [190, 193, 195, 197, 198, 199, 200]) {
    const description = 'x'.repeat(pad) + ' £4871 ono';
    const page = listingPageOf({ ...f.shopListing, description }, f.marloweShop);
    assertShopPage(page, `description with the price at ${pad}`);
  }
});

Deno.test('the price a shop typed is the only thing taken out of the words around it', () => {
  const page = listingPageOf(f.shopListingHostile, f.marloweShopHostile);
  assertStringIncludes(
    page,
    '<title>Teak sideboard ono — Marlowe Antiques &lt;b&gt; on Logosell</title>',
  );
  assertStringIncludes(page, '<h1>Teak sideboard ono</h1>');
  assertStringIncludes(
    page,
    '<meta property="og:title" content="Teak sideboard ono — Marlowe Antiques &lt;b&gt;">',
  );
  assertFalse(page.includes('<b>'), 'a trading name was not escaped');
  const seller = sellerPageOf(f.shopStock, f.marloweShopHostile);
  assertStringIncludes(seller, '<h1>Marlowe Antiques &lt;b&gt;</h1>');
  // A title that was nothing but a price has a stand-in, not an empty heading.
  const bare = listingPageOf(f.shopListingPriceOnly, f.marloweShop);
  assertStringIncludes(bare, '<h1>Item in store</h1>');
});

Deno.test('a shop page names the shop, the hours, the count, and says where it is sold', () => {
  const open = sellerPageOf(f.shopStock, f.marloweShop);
  assertStringIncludes(open, '<h1>Marlowe &amp; Daughters</h1>');
  assertStringIncludes(open, 'Open now · Today 09:00–12:30, 13:30–17:30');
  assertStringIncludes(open, '3 pieces in store');
  assertStringIncludes(open, SHOP_NOTE);
  assertStringIncludes(
    sellerPageOf(f.shopStock, f.marloweShopClosed),
    'Closed now · Today 09:00–12:30, 13:30–17:30',
  );
  assertStringIncludes(sellerPageOf(f.shopStock, f.marloweShopClosedToday), 'Closed today');

  // Hours never set: say nothing about opening. open_now is false for such a shop, and
  // "Closed now" would be a claim nobody made.
  const unset = sellerPageOf(f.shopStock, f.marloweShopNoHours);
  assertFalse(
    /Closed now|Open now|Closed today|Today \d/.test(unset),
    'claimed opening hours it does not have',
  );
  assertStringIncludes(unset, '3 pieces in store');

  // The count is the larger of what was listed and what the shop says it has, and it
  // agrees with itself in the singular and the empty case.
  assertStringIncludes(
    sellerPageOf(f.shopStock, { ...f.marloweShop, listings_live: 57 }),
    '57 pieces in store',
  );
  assertStringIncludes(
    sellerPageOf([f.shopListing], { ...f.marloweShop, listings_live: 1 }),
    '1 piece in store',
  );
  assertStringIncludes(sellerPageOf([f.shopListing], null), '1 piece in store');
  // A count that is not a whole, positive, finite number is not trusted: JSON.parse reads
  // 1e999 as Infinity, and "Infinity pieces in store" is not a thing to print.
  assertStringIncludes(
    sellerPageOf(f.shopStock, { ...f.marloweShop, listings_live: 57.9 }),
    '57 pieces in store',
  );
  for (const odd of [Infinity, -Infinity, NaN, -5, 0]) {
    const page = sellerPageOf(f.shopStock, { ...f.marloweShop, listings_live: odd });
    assertStringIncludes(page, '3 pieces in store', `listings_live ${odd}`);
    assertFalse(/Infinity|NaN/.test(page), `listings_live ${odd} reached the page`);
  }
  const empty = sellerPageOf([], { ...f.marloweShopClosedToday, listings_live: 0 });
  assertStringIncludes(empty, 'Nothing in store right now');
  assertFalse(/\d+ pieces? in store/.test(empty));

  const listing = listingPageOf(f.shopListing, f.marloweShop);
  assertStringIncludes(listing, 'Ask in store');
  assertStringIncludes(
    listing,
    'Sold by Marlowe &amp; Daughters · Open now · Today 09:00–12:30, 13:30–17:30',
  );
  assertStringIncludes(listing, SHOP_NOTE);
  assertStringIncludes(listing, `href="${f.ORIGIN}/seller/${f.TRADER_ID}"`);
  for (const row of sellerPageOf(f.shopStock, f.marloweShop).split('<a class="row"').slice(1)) {
    assertStringIncludes(row, 'Ask in store');
  }
});

Deno.test('a shop page gives away nothing the shop front was not meant to carry', () => {
  // data.ts copies only the whitelisted fields; this is the second lock: even handed the
  // whole row, the renderer has nowhere to put an address, a rating or a company number.
  const row = {
    ...f.marloweShop,
    address: '12 High Street, Hounslow TW3 1AA',
    postcode: 'TW3 1AA',
    company_number: '01234567',
    lat: 51.4684,
    lng: -0.3615,
    rating: 4.9,
    rating_count: 77,
    collection_note: 'Ring the bell twice',
  } as ShopFront;
  const pages = [listingPageOf(f.shopListing, row), sellerPageOf(f.shopStock, row)];
  for (const page of pages) {
    for (
      const secret of ['12 High Street', 'TW3', '01234567', '51.46', '0.36', '4.9', 'Ring the bell']
    ) {
      assertFalse(page.includes(secret), `the page printed "${secret}"`);
    }
    assertShopPage(page, 'shop page given the whole shop_front row');
  }
});

Deno.test('a shop page is styled only by classes the stylesheet already has, and the CSP still fits', () => {
  const pages = [
    listingPageOf(f.shopListing, f.marloweShop),
    listingPageOf(f.shopListingPriceOnly, null),
    sellerPageOf(f.shopStock, f.marloweShop),
    sellerPageOf([], null),
  ];
  for (const page of pages) {
    assertFalse(/\sstyle\s*=/i.test(page), 'a shop page carries an inline style');
    const classes = [...page.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(
      Boolean,
    );
    assert(classes.length > 5);
    for (const c of new Set(classes)) {
      assert(new RegExp(`\\.${c}(?![\\w-])`).test(CSS), `class "${c}" is not defined in CSS`);
    }
    assertEquals(page.match(/<style>/g)?.length, 1, 'expected exactly one <style> block');
  }
});

/* ── 4. The router ────────────────────────────────────────────────────────────────────────── */

const ENV = { url: 'https://db.example.co', anon: 'anon-key' };
const ALL_LISTINGS: Listing[] = [
  f.listingFull,
  f.listingCityOnly,
  f.listingBare,
  f.shopListing,
  f.shopListingHostile,
  f.shopListingPriceOnly,
];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type World = Deps & { staticHits: string[]; shopAsked: string[] };

/** A small marketplace: two private sellers, one verified trader, one listing whose seller
 *  nobody can name. Every read is a fake; nothing here can reach a network. */
function world(over: Partial<Deps> = {}): World {
  const staticHits: string[] = [];
  const shopAsked: string[] = [];
  const base: Deps = {
    env: ENV,
    serveStatic: (req) => {
      staticHits.push(new URL(req.url).pathname);
      return Promise.resolve(new Response('static'));
    },
    fetchListing: (_e, id) => Promise.resolve(ALL_LISTINGS.find((l) => same(l.id, id)) ?? null),
    fetchSeller: (_e, id) =>
      Promise.resolve(
        same(id, f.TRADER_ID)
          ? { seller: f.marlowe, listings: f.shopStock }
          : same(id, f.SELLER_ID)
          ? { seller: f.priya, listings: [f.listingFull, f.listingCityOnly] }
          : same(id, f.SELLER_ID_2)
          ? { seller: f.sam, listings: [] }
          : null,
      ),
    fetchPublicListings: () => Promise.resolve([]),
    fetchZone: (_e, slug) => Promise.resolve(slug === 'hounslow' ? f.hounslow : null),
    fetchZoneListings: () => Promise.resolve(f.mixedZoneListings),
    fetchZoneCategories: () => Promise.resolve(f.categories),
    fetchTraders: () => Promise.resolve(new Set([f.TRADER_ID])),
    fetchShop: (_e, id) => {
      shopAsked.push(id);
      return Promise.resolve(same(id, f.TRADER_ID) ? f.marloweShop : null);
    },
    ...over,
  };
  return Object.assign(base, { staticHits, shopAsked });
}

const get = (path: string, init?: RequestInit) =>
  handle(new Request(`https://logosell.app${path}`, init), undefined as unknown as Deps);
const ask = (d: Deps, path: string, init?: RequestInit) =>
  handle(new Request(`https://logosell.app${path}`, init), d);
void get;

async function page(d: Deps, path: string): Promise<{ res: Response; body: string }> {
  const res = await ask(d, path);
  return { res, body: await res.text() };
}

const golden = (name: string) => Deno.readTextFile(new URL(`./golden/${name}`, import.meta.url));

function assertRefused(res: Response, body: string, what: string) {
  assertEquals(res.status, 404, `${what}: expected a refusal`);
  assertEquals(
    res.headers.get('Cache-Control'),
    'no-store',
    `${what}: a refusal must not be cached`,
  );
  assertEquals(priceLeaks(body), [], `${what}: the refusal shows a price`);
  assertFalse(/£\d/.test(body), `${what}: the refusal shows a price`);
}

Deno.test("route: a verified trader's listing is a shop page, cached briefly", async () => {
  const d = world();
  const { res, body } = await page(d, `/listing/${f.SHOP_LISTING_ID}`);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('Cache-Control'), 'public, max-age=60');
  assertShopPage(body, "GET /listing/<trader's>");
  assertStringIncludes(body, 'Ask in store');
  assertStringIncludes(body, 'Open now · Today 09:00–12:30, 13:30–17:30');
  assertEquals(d.shopAsked, [f.TRADER_ID], 'the shop front was not asked for the right seller');
});

Deno.test("route: a verified trader's page is a shop page", async () => {
  const d = world();
  const { res, body } = await page(d, `/seller/${f.TRADER_ID}`);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('Cache-Control'), 'public, max-age=60');
  assertShopPage(body, 'GET /seller/<trader>');
  assertStringIncludes(body, '3 pieces in store');
  assertStringIncludes(body, SHOP_NOTE);
});

Deno.test('route: one zone page holds both kinds, each as it should be', async () => {
  const { res, body } = await page(world(), '/hounslow');
  assertEquals(res.status, 200);
  // Private sellers keep their prices. Everything else is a price-free row.
  assertStringIncludes(body, '£1,250');
  assertStringIncludes(body, '£15');
  assertFalse(FIXTURE_PRICES.test(body.replace(STYLE_BLOCK, '')), 'a shop row carries its price');
  assertEquals(
    body.match(/Ask in store/g)?.length,
    3,
    'shop rows, and the row whose seller is unknown',
  );
  assertFalse(body.includes('£0'), 'a row whose seller is unknown was priced');
  const allShop = world({ fetchZoneListings: () => Promise.resolve(f.shopStock) });
  const shops = await page(allShop, '/hounslow/furniture');
  assertEquals(shops.res.status, 200);
  assertEquals(priceLeaks(shops.body), []);
});

Deno.test('route: a seller who is not a trader gets a person-to-person page, even among traders', async () => {
  const crowd = new Set([
    f.TRADER_ID,
    '00000000-0000-4000-8000-000000000000',
    f.SELLER_ID.replace('7', '8'),
  ]);
  const d = world({ fetchTraders: () => Promise.resolve(crowd) });
  assertEquals((await page(d, `/listing/${f.LISTING_ID}`)).body, await golden('listing-full.html'));
  assertEquals(
    (await page(d, `/listing/${f.LISTING_ID_2}`)).body,
    await golden('listing-city.html'),
  );
  assertEquals((await page(d, `/seller/${f.SELLER_ID}`)).body, await golden('seller-rated.html'));
  assertEquals((await page(d, `/seller/${f.SELLER_ID_2}`)).body, await golden('seller-empty.html'));
  const priced = await ask(d, `/listing/${f.LISTING_ID}`);
  assertEquals(priced.headers.get('Cache-Control'), 'public, max-age=300');
  await priced.body?.cancel();
  assertEquals(d.shopAsked, [], "a private seller's page asked the shop front");
});

Deno.test('route: capital letters in an id do not turn a trader back into a private seller', async () => {
  const d = world();
  for (
    const path of [
      `/seller/${f.TRADER_ID.toUpperCase()}`,
      `/listing/${f.SHOP_LISTING_ID.toUpperCase()}`,
    ]
  ) {
    const { res, body } = await page(d, path);
    assertEquals(res.status, 200, path);
    assertShopPage(body, path);
  }
  // And the canonical link names the lower-case id, one URL per page.
  const { body } = await page(d, `/seller/${f.TRADER_ID.toUpperCase()}`);
  assertStringIncludes(body, `<link rel="canonical" href="${f.ORIGIN}/seller/${f.TRADER_ID}">`);
});

/** The ways "is this seller a trader?" can fail to be answered. */
const NO_ANSWER: [string, Deps['fetchTraders']][] = [
  ['the list could not be read', () => Promise.resolve(null)],
  ['the reader threw', () => {
    throw new Error('boom');
  }],
  ['the reader rejected', () => Promise.reject(new Error('boom'))],
];

Deno.test('route: when the trader list cannot be had, no page with a price goes out', async () => {
  for (const [why, fetchTraders] of NO_ANSWER) {
    const d = world({ fetchTraders });
    for (
      const path of [
        `/listing/${f.SHOP_LISTING_ID}`,
        `/listing/${f.LISTING_ID}`,
        `/listing/${f.LISTING_ID_2}`,
        `/seller/${f.TRADER_ID}`,
        `/seller/${f.SELLER_ID}`,
        `/seller/${f.SELLER_ID_2}`,
        '/hounslow',
        '/hounslow/furniture',
      ]
    ) {
      const { res, body } = await page(d, path);
      assertRefused(res, body, `${path}, ${why}`);
    }
    assertEquals(d.staticHits, [], `${why}: a refusal fell through to the static site`);
  }
});

Deno.test('route: with no trader list, a zone with nothing in it still renders, and has no price to show', async () => {
  const empty = world({
    fetchTraders: () => Promise.resolve(null),
    fetchZoneListings: () => Promise.resolve([]),
    fetchZoneCategories: () => Promise.resolve([]),
  });
  const { res, body } = await page(empty, '/hounslow');
  assertEquals(res.status, 200);
  assertEquals(priceLeaks(body), []);
  assertStringIncludes(body, 'Nothing listed here yet.');
});

Deno.test('route: an unreadable shop front shortens the header and changes nothing else', async () => {
  for (
    const fetchShop of [
      () => Promise.resolve(null),
      () => {
        throw new Error('boom');
      },
      () => Promise.reject(new Error('boom')),
    ] as Deps['fetchShop'][]
  ) {
    const d = world({ fetchShop });
    for (const path of [`/listing/${f.SHOP_LISTING_ID}`, `/seller/${f.TRADER_ID}`]) {
      const { res, body } = await page(d, path);
      assertEquals(res.status, 200, path);
      assertShopPage(body, `${path} without a shop front`);
      assertStringIncludes(body, 'Marlowe');
      assertFalse(/Open now|Closed now|Today \d/.test(body), 'hours without a shop front');
    }
  }
});

Deno.test('route: a listing that does not say whose it is gets no page, not a price page', async () => {
  const anonymous: Listing[] = [
    f.listingBare,
    { ...f.listingFull, seller: null },
    { ...f.listingFull, seller: {} },
    { ...f.listingFull, seller_id: '', seller: null },
    { ...f.listingFull, seller_id: 42 as unknown as string, seller: null },
    { ...f.shopListing, seller_id: null, seller: undefined },
  ];
  for (const listing of anonymous) {
    const d = world({ fetchListing: () => Promise.resolve(listing) });
    const { res, body } = await page(d, `/listing/${listing.id}`);
    assertRefused(res, body, `listing ${JSON.stringify(listing.title)} with no seller`);
  }
});

Deno.test('route: the same refusal for an id that is not a listing at all', async () => {
  const d = world();
  for (const path of ['/listing/not-a-uuid', `/listing/${f.LISTING_ID}x`, '/seller/nope']) {
    const { res, body } = await page(d, path);
    assertRefused(res, body, path);
  }
  const gone = await page(
    world({ fetchListing: () => Promise.resolve(null) }),
    `/listing/${f.LISTING_ID}`,
  );
  assertRefused(gone.res, gone.body, 'a listing that does not exist');
  assertEquals(await golden('unavailable.html'), gone.body);
});

Deno.test('route: a shop page never reaches the browser-side renderer that prints prices', async () => {
  // s.html reads the price straight from the database and would show a trader's to anyone
  // who typed its URL. The server never serves it; it sends the request to the page that
  // knows about shop mode. Eleven forms of the same request:
  const id = f.TRADER_ID;
  const d = world();
  const redirects: [string, string][] = [
    [`/s.html?t=listing&id=${f.SHOP_LISTING_ID}`, `/listing/${f.SHOP_LISTING_ID}`],
    [`/s.html?t=seller&id=${id}`, `/seller/${id}`],
    [`/s.html?t=seller&id=${id.toUpperCase()}`, `/seller/${id}`],
    [`/s.html?id=${id}&t=seller`, `/seller/${id}`],
    [`/s.html?utm=1&t=seller&id=${id}&x=2`, `/seller/${id}`],
    [`/s.html?t=listing&id=${id}&`, `/listing/${id}`],
    [`/%73.html?t=seller&id=${id}`, `/seller/${id}`],
    [`/%73%2ehtml?t=seller&id=${id}`, `/seller/${id}`],
  ];
  for (const [from, to] of redirects) {
    const res = await ask(d, from);
    assertEquals(res.status, 302, from);
    assertEquals(res.headers.get('Location'), to, from);
    assertEquals(res.headers.get('Cache-Control'), 'no-store', from);
    await res.body?.cancel();
  }
  const head = await ask(d, `/s.html?t=seller&id=${id}`, { method: 'HEAD' });
  assertEquals(head.status, 302);
  await head.body?.cancel();
  assertEquals(d.staticHits, [], 'a redirected request still reached the static site');

  // Anything s.html could not parse is left to the file, which prints "not available" and
  // reads nothing. These are the requests the file's own two patterns refuse.
  const unreadable = [
    '/s.html',
    '/s.html?t=listing',
    `/s.html?id=${id}`,
    `/s.html?t=other&id=${id}`,
    `/s.html?t=seller&id=${id}x`,
    '/s.html?t=seller&id=short',
    `/s.html?t=sellers&id=${id}`,
  ];
  for (const from of unreadable) {
    const res = await ask(d, from);
    assertEquals(await res.text(), 'static', from);
  }
  assertEquals(d.staticHits.length, unreadable.length);
  const post = await ask(d, `/s.html?t=seller&id=${id}`, { method: 'POST' });
  assertEquals(await post.text(), 'static', 'only GET and HEAD are redirected');
});

Deno.test('route: s.html still reads the kind and the id the way the server copied it', async () => {
  // The two patterns the server mirrors. If s.html learns a new way to read an id, this
  // fails, and the server's copy has to learn it too or a price can slip past it.
  // (`includes`, not assertStringIncludes: a failure there prints the whole file.)
  const html = await Deno.readTextFile(new URL('../s.html', import.meta.url));
  for (
    const pattern of [
      String.raw`/[?&]t=(listing|seller)(?:&|$)/`,
      String.raw`/[?&]id=([0-9a-fA-F-]{36})(?:&|$)/`,
    ]
  ) {
    assert(html.includes(pattern), `s.html no longer contains ${pattern}`);
  }
});

/* ── 5. The real data layer, with only the network replaced ───────────────────────────────── */

const DB_ENV = { url: 'https://db.example.co', anon: 'anon-key' };
const PENDING_ID = '5d5d5d5d-5d5d-45d5-85d5-5d5d5d5d5d5d';
const REJECTED_ID = '6e6e6e6e-6e6e-46e6-86e6-6e6e6e6e6e6e';
const PENDING_LISTING_ID = 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70';
const ORPHAN_LISTING_ID = 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a81';

type Row = Record<string, unknown>;

interface FakeDb {
  /** How reading markety.trader_accounts behaves. */
  traderRead: 'ok' | 'down' | 'unreachable' | 'garbage';
  traders: Row[];
  shopFront: 'ok' | 'down';
  listings: Listing[];
  zoneListings: Listing[];
  profiles: Seller[];
}

/** What markety.shop_front really returns: more than a page may use. */
const SHOP_FRONT_ROW: Row = {
  business_name: 'Marlowe & Daughters',
  display_name: 'Marlowe',
  city: 'Hounslow',
  hours_today: [['09:00', '12:30'], ['13:30', '17:30']],
  open_now: true,
  listings_live: 3,
  company_number: '08765432',
  pub_lat: 51.4684,
  pub_lng: -0.3616,
  rating: f.SHOP_RATING,
  rating_count: f.SHOP_RATING_COUNT,
  sales_count: f.SHOP_SALES,
};

const pat: Seller = { id: PENDING_ID, display_name: 'Pat', verified: false, city: 'Isleworth' };
const owned = (
  l: Listing,
  sellerId: string,
  seller: Seller | null = l.seller ?? null,
): Listing => ({ ...l, seller_id: sellerId, seller });

function standardDb(): FakeDb {
  const full = owned(f.listingFull, f.SELLER_ID);
  const city = owned(f.listingCityOnly, f.SELLER_ID_2);
  return {
    traderRead: 'ok',
    traders: [
      // Stored in capitals on purpose: the set is keyed by the lower-case form.
      { profile_id: f.TRADER_ID.toUpperCase(), status: 'verified' },
      { profile_id: PENDING_ID, status: 'pending' },
      { profile_id: REJECTED_ID, status: 'rejected' },
    ],
    shopFront: 'ok',
    listings: [
      full,
      city,
      owned(f.listingBare, f.SELLER_ID_2, null),
      f.shopListing,
      f.shopListingHostile,
      f.shopListingPriceOnly,
      {
        id: PENDING_LISTING_ID,
        seller_id: PENDING_ID,
        title: 'Garden bench',
        price_gbp: 60,
        city: 'Isleworth',
        seller: pat,
      },
    ],
    zoneListings: [
      full,
      f.shopListing,
      { ...f.shopListingHostile, zone_slug: 'hounslow' },
      { ...city, zone_slug: 'hounslow' },
    ],
    profiles: [f.priya, f.sam, f.marlowe, pat],
  };
}

function splitSelect(select: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of select) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** What PostgREST does with `select=`: only the named columns come back, and an embed
 *  (`seller:profiles!fk(a,b)`) comes back as its own object, or null. */
function project(row: Row, select: string): Row {
  if (select === '*') return row;
  const out: Row = {};
  for (const col of splitSelect(select)) {
    const embed = /^(\w+):\w+(?:![\w]+)?\(([^)]*)\)$/.exec(col);
    if (embed) {
      const sub = row[embed[1]];
      out[embed[1]] = sub && typeof sub === 'object' ? project(sub as Row, embed[2]) : null;
    } else if (col in row) {
      out[col] = row[col];
    }
  }
  return out;
}

interface Net {
  calls: string[];
  /** Tables the fake has no answer for. */
  unknown: string[];
  /** Anything that was not a plain anon GET on the markety schema. */
  bad: string[];
  warnings: string[];
  restore: () => void;
}

function fakeDatabase(db: FakeDb): Net {
  const net: Net = { calls: [], unknown: [], bad: [], warnings: [], restore: () => {} };
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (
      (init?.method ?? 'GET') !== 'GET' || init?.body != null || url.origin !== DB_ENV.url ||
      headers['Accept-Profile'] !== 'markety' || headers.apikey !== DB_ENV.anon ||
      headers.Authorization !== `Bearer ${DB_ENV.anon}`
    ) {
      net.bad.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    }
    const table = url.pathname.replace(/^\/rest\/v1\//, '');
    net.calls.push(table + url.search);
    const q = url.searchParams;
    const eq = (name: string) => q.get(name)?.replace(/^eq\./, '').toLowerCase();
    const limit = Number(q.get('limit') ?? 1000);
    const select = q.get('select') ?? '*';
    const lc = (v: unknown) => String(v).toLowerCase();
    switch (table) {
      case 'trader_accounts': {
        if (db.traderRead === 'unreachable') return Promise.reject(new TypeError('network down'));
        if (db.traderRead === 'down') return json({ message: 'unavailable' }, 503);
        if (db.traderRead === 'garbage') return json({ message: 'not a list' });
        const status = eq('status');
        const after = q.get('profile_id')?.replace(/^gt\./, '').toLowerCase();
        const rows = db.traders
          .filter((r) => !status || lc(r.status) === status)
          .filter((r) => !after || lc(r.profile_id) > after)
          .sort((a, b) => (lc(a.profile_id) < lc(b.profile_id) ? -1 : 1));
        return json(rows.slice(0, limit).map((r) => project(r, select)));
      }
      case 'rpc/shop_front': {
        if (db.shopFront === 'down') return json({ message: 'unavailable' }, 500);
        return json(lc(q.get('p_trader')) === f.TRADER_ID ? [SHOP_FRONT_ROW] : []);
      }
      case 'listings': {
        const source = q.has('zone_slug') ? db.zoneListings : db.listings;
        const id = eq('id');
        const seller = eq('seller_id');
        const category = eq('category_id');
        return json(
          source
            .filter((l) => !id || lc(l.id) === id)
            .filter((l) => !seller || sellerIdOf(l) === seller)
            .filter((l) => !category || lc(l.category_id) === category)
            .slice(0, limit)
            .map((l) => project(l as unknown as Row, select)),
        );
      }
      case 'profiles': {
        const id = eq('id');
        return json(
          db.profiles.filter((p) => lc(p.id) === id).slice(0, limit)
            .map((p) => project(p as unknown as Row, select)),
        );
      }
      case 'zones':
        return json([{ slug: 'hounslow', name: 'Hounslow' }]);
      case 'categories':
        return json(f.categories.map(({ id, name, emoji }) => ({ id, name, emoji })));
      default:
        net.unknown.push(table);
        return json({ message: 'no such table' }, 404);
    }
  }) as typeof fetch;
  console.warn = (...args: unknown[]) => {
    net.warnings.push(args.join(' '));
  };
  net.restore = () => {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  };
  return net;
}

/** A fresh trader cache, the fake network, and everything put back afterwards. */
async function withDatabase(db: FakeDb, body: (net: Net) => Promise<void>): Promise<void> {
  resetTraderCache();
  const net = fakeDatabase(db);
  try {
    await body(net);
  } finally {
    net.restore();
    resetTraderCache();
  }
}

/** Every reader is the real one. */
const realDeps = (env: Deps['env'] = DB_ENV): Deps => ({
  env,
  serveStatic: () => Promise.resolve(new Response('static')),
});

/** Date.now() under the test's control, for the cache windows. */
async function withClock(start: number, body: (set: (t: number) => void) => Promise<void>) {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  try {
    await body((t) => {
      now = t;
    });
  } finally {
    Date.now = real;
  }
}

Deno.test('data layer: every seller gets the page that is theirs, through the real readers', async () => {
  await withDatabase(standardDb(), async (net) => {
    const d = realDeps();

    // A verified trader: shop pages.
    const shopListing = await page(d, `/listing/${f.SHOP_LISTING_ID}`);
    assertEquals(shopListing.res.status, 200);
    assertEquals(shopListing.res.headers.get('Cache-Control'), 'public, max-age=60');
    assertShopPage(shopListing.body, "GET /listing/<trader's>");
    assertStringIncludes(shopListing.body, 'Open now · Today 09:00–12:30, 13:30–17:30');

    const shopSeller = await page(d, `/seller/${f.TRADER_ID}`);
    assertEquals(shopSeller.res.status, 200);
    assertEquals(shopSeller.res.headers.get('Cache-Control'), 'public, max-age=60');
    assertShopPage(shopSeller.body, 'GET /seller/<trader>');
    assertStringIncludes(shopSeller.body, 'Marlowe &amp; Daughters');
    assertStringIncludes(shopSeller.body, '3 pieces in store');
    // shop_front returns more than a page may print: none of it is on the page.
    for (const secret of ['08765432', '51.4684', '-0.3616']) {
      assertFalse(shopSeller.body.includes(secret), `shop_front's ${secret} reached the page`);
    }

    // A private seller: exactly the pages they always had.
    const priced = await page(d, `/listing/${f.LISTING_ID}`);
    assertEquals(priced.res.headers.get('Cache-Control'), 'public, max-age=300');
    assertEquals(priced.body, await golden('listing-full.html'));
    assertEquals(
      (await page(d, `/listing/${f.LISTING_ID_2}`)).body,
      await golden('listing-city.html'),
    );

    // A seller whose application is pending or was rejected is not a verified trader.
    const pending = await page(d, `/seller/${PENDING_ID}`);
    assertEquals(pending.res.status, 200);
    assertEquals(pending.res.headers.get('Cache-Control'), 'public, max-age=300');
    assertStringIncludes(pending.body, '£60');
    const bench = await page(d, `/listing/${PENDING_LISTING_ID}`);
    assertStringIncludes(bench.body, '£60');

    // One zone page, both kinds.
    const zone = await page(d, '/hounslow');
    assertEquals(zone.res.status, 200);
    assertStringIncludes(zone.body, '£1,250');
    assertStringIncludes(zone.body, '£15');
    assertFalse(
      FIXTURE_PRICES.test(zone.body.replace(STYLE_BLOCK, '')),
      "a trader's price is on the zone page",
    );
    assertEquals(zone.body.match(/Ask in store/g)?.length, 2);

    // What was asked of the database.
    assertEquals(net.bad, [], 'a request was not a plain anon GET on the markety schema');
    assertEquals(net.unknown, [], 'a page read a table nobody expected');
    assertEquals(net.warnings, []);
    const traderReads = net.calls.filter((c) =>
      c.startsWith('trader_accounts?') && !c.includes('profile_id=gt.')
    );
    assertEquals(traderReads.length, 1, 'the trader list is read once, then served from the cache');
    assertStringIncludes(traderReads[0], 'status=eq.verified');
    assertStringIncludes(traderReads[0], 'select=profile_id');
  });
});

Deno.test("data layer: a trader's listing is a shop page even when its profile cannot be embedded", async () => {
  // `seller_id` is selected beside the embed. Without it this listing would say nothing
  // about whose it is, and the page would (rightly) be refused.
  const db = standardDb();
  db.listings.push({ ...f.shopListing, id: ORPHAN_LISTING_ID, seller: null });
  await withDatabase(db, async () => {
    const { res, body } = await page(realDeps(), `/listing/${ORPHAN_LISTING_ID}`);
    assertEquals(res.status, 200);
    assertShopPage(body, "a trader's listing without an embedded profile");
    assertStringIncludes(body, 'Ask in store');
  });
});

Deno.test('data layer: an unreadable shop front leaves the shop page without hours, and with no price', async () => {
  await withDatabase({ ...standardDb(), shopFront: 'down' }, async () => {
    for (const path of [`/listing/${f.SHOP_LISTING_ID}`, `/seller/${f.TRADER_ID}`]) {
      const { res, body } = await page(realDeps(), path);
      assertEquals(res.status, 200, path);
      assertShopPage(body, `${path} with the shop front down`);
      assertFalse(/Open now|Closed now|Today \d/.test(body));
    }
  });
});

Deno.test('data layer: when the database cannot say who the traders are, no price page goes out, and the log says so once', async () => {
  for (const traderRead of ['down', 'unreachable', 'garbage'] as const) {
    await withDatabase({ ...standardDb(), traderRead }, async (net) => {
      const d = realDeps();
      for (
        const path of [
          `/listing/${f.SHOP_LISTING_ID}`,
          `/listing/${f.LISTING_ID}`,
          `/seller/${f.TRADER_ID}`,
          `/seller/${f.SELLER_ID}`,
          `/seller/${PENDING_ID}`,
          '/hounslow',
        ]
      ) {
        const { res, body } = await page(d, path);
        assertRefused(res, body, `${path}, trader read ${traderRead}`);
      }
      assertEquals(
        net.warnings.length,
        1,
        `trader read ${traderRead}: one warning, not one per request`,
      );
      assertStringIncludes(net.warnings[0], 'verified-trader list unreadable');
    });
  }
});

Deno.test('data layer: no database configured means no verdict, and so no price page', async () => {
  await withDatabase(standardDb(), async (net) => {
    const d: Deps = {
      ...realDeps({ url: '', anon: '' }),
      fetchListing: () => Promise.resolve(f.listingFull),
      fetchSeller: () => Promise.resolve({ seller: f.priya, listings: [f.listingFull] }),
    };
    for (const path of [`/listing/${f.LISTING_ID}`, `/seller/${f.SELLER_ID}`]) {
      const { res, body } = await page(d, path);
      assertRefused(res, body, `${path}, nothing configured`);
    }
    assertEquals(net.calls, [], 'something was requested although no database is configured');
    assertEquals(net.warnings, [], 'an unconfigured server should not warn about the database');
  });
});

Deno.test('data layer: the cache windows are a minute for the list and fifteen for an outage', async () => {
  const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
  const db = standardDb();
  db.traders = []; // nobody is a trader yet
  await withDatabase(db, async (net) => {
    await withClock(T0, async (setNow) => {
      const d = realDeps();
      const who = (id: string) => page(d, `/seller/${id}`);
      const isShop = (body: string) => body.includes(SHOP_NOTE);

      assertFalse(isShop((await who(f.TRADER_ID)).body), 'before verification: a private seller');

      // The trader is verified. The list is stale for up to a minute, so for that long the
      // page is still the private one: this is the window the runbook tells the owner to wait out.
      db.traders = [{ profile_id: f.TRADER_ID, status: 'verified' }];
      setNow(T0 + 59_999);
      assertFalse(isShop((await who(f.TRADER_ID)).body), 'just under a minute: cached list');
      setNow(T0 + 60_000);
      const shop = await who(f.TRADER_ID);
      assert(isShop(shop.body), 'a minute on: the list is read again and the page is a shop page');
      assertShopPage(shop.body, 'seller page after the refresh');
      const verifiedAt = T0 + 60_000;

      // An outage. The last good list stands in, up to fifteen minutes after it was read...
      db.traderRead = 'down';
      setNow(verifiedAt + 15 * 60_000 - 1);
      assert(isShop((await who(f.TRADER_ID)).body), 'just under fifteen minutes into an outage');
      assertEquals(net.warnings, [], 'the stale list is working; nothing to warn about yet');

      // ...and then it is dropped: 404, never a price page.
      setNow(verifiedAt + 15 * 60_000);
      const { res, body } = await who(f.TRADER_ID);
      assertRefused(res, body, 'fifteen minutes into an outage');
      const other = await who(f.SELLER_ID);
      assertRefused(other.res, other.body, 'a private seller, fifteen minutes into an outage');
      assertEquals(net.warnings.length, 1);

      // The database comes back: the very next request recovers, nothing waits out a timer.
      db.traderRead = 'ok';
      setNow(verifiedAt + 15 * 60_000 + 1);
      assert(isShop((await who(f.TRADER_ID)).body), 'recovered');
      assertEquals((await who(f.SELLER_ID)).res.status, 200);
    });
  });
});

/* ── 6. The committed snapshots ───────────────────────────────────────────────────────────── */

Deno.test('the committed shop snapshots carry no price, rating or sales count', async () => {
  const dir = new URL('./golden/', import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.name.startsWith('shop-')) names.push(e.name);
  assert(names.length >= 11, `only ${names.length} shop snapshots: a case was dropped`);
  for (const name of names.sort()) {
    if (name === 'shop-zone-mixed.html') continue; // row by row, below
    assertShopPage(await Deno.readTextFile(new URL(name, dir)), name);
  }
});

Deno.test('the committed mixed zone snapshot: a private row may have a price, no other row may', async () => {
  const page = await Deno.readTextFile(new URL('./golden/shop-zone-mixed.html', import.meta.url));
  const rows = [
    ...page.matchAll(/<a class="row" href="[^"]*\/listing\/([0-9a-f-]{36})">[\s\S]*?<\/a>/g),
  ];
  assertEquals(rows.length, 5, 'the snapshot lost a row');
  const priceable = new Set([f.LISTING_ID, f.LISTING_ID_2]); // private sellers
  let withPrice = 0;
  for (const [row, id] of rows) {
    const leaks = priceLeaks(row);
    if (priceable.has(id)) {
      if (leaks.length) withPrice++;
    } else {
      assertEquals(leaks, [], `row ${id} is not a private seller's, and shows a price`);
      assertStringIncludes(row, 'Ask in store');
    }
  }
  assertEquals(withPrice, 2, 'the private rows lost their prices: shop mode reached them');
  // The structured data is the same list with no price in it.
  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page)?.[1];
  assert(ld);
  assertEquals(priceLeaks(`<script type="application/ld+json">${ld}</script>`), []);
});
