/**
 * Fixed inputs shared by the golden pages and the shop-mode tests.
 *
 * Type-only imports on purpose: the golden generator and the tests build their
 * pages from these, and nothing here may depend on the code under test.
 */
import type { CategoryCount, Listing, Seller, ShopFront, Zone } from './render.ts';

export const ORIGIN = 'https://logosell.app';

export const LISTING_ID = '550e8400-e29b-41d4-a716-446655440000';
export const LISTING_ID_2 = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
export const LISTING_ID_3 = '9b2f4c1e-3d7a-4e58-9a61-2f0c8d5b7e14';
export const SELLER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const SELLER_ID_2 = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

export const priya: Seller = {
  id: SELLER_ID,
  display_name: 'Priya',
  verified: true,
  city: 'Hounslow',
  rating: 4.8,
  rating_count: 12,
};

export const sam: Seller = { id: SELLER_ID_2, display_name: 'Sam', verified: false };

const IMAGE = 'https://db.example.co/storage/v1/object/public/l/1.jpg';

/** Every field present, with characters that must be escaped and a price big
 *  enough to need a thousands separator. */
export const listingFull: Listing = {
  id: LISTING_ID,
  title: 'Oak dining table & 6 chairs',
  description: 'Solid oak, seats six.  Collected from Hounslow. "Good" condition <ask me>.',
  price_gbp: 1250,
  images: [IMAGE],
  city: 'Hounslow',
  condition: 'like_new',
  created_at: '2026-10-14T09:00:00Z',
  category_id: 'furniture',
  zone_slug: 'hounslow',
  seller: priya,
};

/** No photo, no description, no zone: the city badge and the unverified
 *  seller line. */
export const listingCityOnly: Listing = {
  id: LISTING_ID_2,
  title: 'Floor lamp',
  price_gbp: 15,
  city: 'Isleworth',
  condition: 'fair',
  category_id: 'furniture',
  seller: sam,
};

/** As little as the database could hand back. */
export const listingBare: Listing = {
  id: LISTING_ID_3,
  title: "Kid's bike",
  price_gbp: 0,
  category_id: 'bikes',
  seller: null,
};

export const hounslow: Zone = { slug: 'hounslow', name: 'Hounslow' };

export const categories: CategoryCount[] = [
  { id: 'furniture', name: 'Furniture', emoji: '🪑', n: 2 },
  { id: 'bikes', name: 'Bikes', emoji: null, n: 1 },
];

export const zoneListings: Listing[] = [listingFull, listingCityOnly, listingBare];

export const sitemapInput = {
  listings: [{ id: LISTING_ID, created_at: '2026-10-14T09:00:00Z' }, { id: LISTING_ID_2 }],
  sellerIds: [SELLER_ID],
  zonePaths: ['/hounslow', '/hounslow/furniture'],
};

/*
  ── Shop mode ───────────────────────────────────────────────────────────────

  A verified trader, and stock that is careful to be awkward. The prices are odd
  numbers (4871, 5230) so that a search of a rendered page for them cannot be
  fooled by an opening hour or a piece count, and the seller carries a rating
  and a sales count so a test can prove the shop pages leave them out.
*/

export const TRADER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
export const SHOP_LISTING_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
export const SHOP_LISTING_ID_2 = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
export const SHOP_LISTING_ID_3 = 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f';

/** What a price-bearing page would have said about this seller. */
export const SHOP_PRICE = 4871;
export const SHOP_RATING = 4.7;
export const SHOP_RATING_COUNT = 213;
export const SHOP_SALES = 1999;

export const marlowe: Seller = {
  id: TRADER_ID,
  display_name: 'Marlowe',
  verified: true,
  city: 'Hounslow',
  rating: SHOP_RATING,
  rating_count: SHOP_RATING_COUNT,
  sales_count: SHOP_SALES,
};

/** Clean copy: the only place the price exists is price_gbp. */
export const shopListing: Listing = {
  id: SHOP_LISTING_ID,
  seller_id: TRADER_ID,
  title: 'Teak sideboard, three drawers',
  description: 'Restored. Solid teak, original handles.  Collect from the shop.',
  price_gbp: SHOP_PRICE,
  images: [IMAGE],
  city: 'Hounslow',
  condition: 'good',
  created_at: '2026-10-15T10:00:00Z',
  category_id: 'furniture',
  zone_slug: 'hounslow',
  seller: marlowe,
};

/** A shop that typed the price into the free text, in every way people do. */
export const shopListingHostile: Listing = {
  id: SHOP_LISTING_ID_2,
  seller_id: TRADER_ID,
  title: 'Teak sideboard £4,871 ono',
  description: 'Was £5,230, now £4,871. Or 4871 GBP, 4,871 pounds, 4871 quid, GBP 4871, ' +
    '&pound;4871, $4871, €4871, £4.9k. Collect Thursday.',
  price_gbp: SHOP_PRICE,
  city: 'Hounslow £4871',
  condition: 'fair',
  category_id: 'furniture',
  seller: marlowe,
};

/** A title that is nothing but a price. */
export const shopListingPriceOnly: Listing = {
  id: SHOP_LISTING_ID_3,
  seller_id: TRADER_ID,
  title: '£4871',
  price_gbp: SHOP_PRICE,
  seller: marlowe,
};

export const marloweShop: ShopFront = {
  business_name: 'Marlowe & Daughters',
  display_name: 'Marlowe',
  city: 'Hounslow',
  hours_today: [['09:00', '12:30'], ['13:30', '17:30']],
  open_now: true,
  listings_live: 3,
};
export const marloweShopClosed: ShopFront = { ...marloweShop, open_now: false };
export const marloweShopNoHours: ShopFront = { ...marloweShop, hours_today: null, open_now: false };
export const marloweShopClosedToday: ShopFront = {
  ...marloweShop,
  hours_today: [],
  open_now: false,
};
/** A trading name with a price in it and markup that must be escaped. */
export const marloweShopHostile: ShopFront = {
  ...marloweShop,
  business_name: 'Marlowe £1 Antiques <b>',
  city: 'Hounslow £5',
};

export const shopStock: Listing[] = [shopListing, shopListingHostile, shopListingPriceOnly];

/** Two private sellers, one shop, and a listing whose seller cannot be told. */
export const mixedZoneListings: Listing[] = [
  listingFull,
  shopListing,
  shopListingHostile,
  listingCityOnly,
  listingBare,
];
