/**
 * The pages that must never change by accident, in two groups.
 *
 *   Person-to-person (every name WITHOUT a `shop-` prefix): every page the
 *   renderer produced before shop mode existed. They were written from the
 *   renderer as it stood then, and shop mode is not allowed to alter one byte.
 *
 *   Shop (`shop-` prefix): what a verified trader's pages look like now. These
 *   are the pages a lawyer should read, and the ones that must never carry a
 *   price: shop_test.ts scans them for one.
 *
 * Each entry is one file under server/golden/, written by golden_update.ts and
 * compared by golden_test.ts.
 */
import {
  listingPage,
  sellerPage,
  shopListingPage,
  shopSellerPage,
  sitemap,
  unavailablePage,
  zonePage,
} from './render.ts';
import * as f from './fixtures.ts';

export const GOLDEN_CASES: Record<string, () => string> = {
  'listing-full.html': () =>
    listingPage({ id: f.LISTING_ID, listing: f.listingFull, origin: f.ORIGIN }),
  'listing-city.html': () =>
    listingPage({ id: f.LISTING_ID_2, listing: f.listingCityOnly, origin: f.ORIGIN }),
  'listing-bare.html': () =>
    listingPage({ id: f.LISTING_ID_3, listing: f.listingBare, origin: f.ORIGIN }),
  'seller-rated.html': () =>
    sellerPage({
      id: f.SELLER_ID,
      seller: f.priya,
      listings: [f.listingFull, f.listingCityOnly],
      origin: f.ORIGIN,
    }),
  'seller-empty.html': () =>
    sellerPage({ id: f.SELLER_ID_2, seller: f.sam, listings: [], origin: f.ORIGIN }),
  'zone.html': () =>
    zonePage({
      zone: f.hounslow,
      listings: f.zoneListings,
      categories: f.categories,
      origin: f.ORIGIN,
    }),
  'zone-category.html': () =>
    zonePage({
      zone: f.hounslow,
      listings: [f.listingFull, f.listingCityOnly],
      categories: f.categories,
      activeCategory: f.categories[0],
      origin: f.ORIGIN,
    }),
  'zone-empty.html': () =>
    zonePage({ zone: f.hounslow, listings: [], categories: [], origin: f.ORIGIN }),
  'unavailable.html': () => unavailablePage(f.ORIGIN),
  'sitemap.xml': () => sitemap({ origin: f.ORIGIN, ...f.sitemapInput }),

  // ── Shop mode ────────────────────────────────────────────────────────────
  'shop-listing.html': () =>
    shopListingPage({
      id: f.SHOP_LISTING_ID,
      listing: f.shopListing,
      origin: f.ORIGIN,
      shop: f.marloweShop,
    }),
  'shop-listing-no-shopfront.html': () =>
    shopListingPage({
      id: f.SHOP_LISTING_ID,
      listing: f.shopListing,
      origin: f.ORIGIN,
      shop: null,
    }),
  'shop-listing-hostile.html': () =>
    shopListingPage({
      id: f.SHOP_LISTING_ID_2,
      listing: f.shopListingHostile,
      origin: f.ORIGIN,
      shop: f.marloweShopHostile,
    }),
  'shop-listing-price-only-title.html': () =>
    shopListingPage({
      id: f.SHOP_LISTING_ID_3,
      listing: f.shopListingPriceOnly,
      origin: f.ORIGIN,
      shop: f.marloweShop,
    }),
  'shop-seller-open.html': () =>
    shopSellerPage({
      id: f.TRADER_ID,
      seller: f.marlowe,
      listings: f.shopStock,
      origin: f.ORIGIN,
      shop: f.marloweShop,
    }),
  'shop-seller-closed.html': () =>
    shopSellerPage({
      id: f.TRADER_ID,
      seller: f.marlowe,
      listings: f.shopStock,
      origin: f.ORIGIN,
      shop: f.marloweShopClosed,
    }),
  'shop-seller-no-hours.html': () =>
    shopSellerPage({
      id: f.TRADER_ID,
      seller: f.marlowe,
      listings: f.shopStock,
      origin: f.ORIGIN,
      shop: f.marloweShopNoHours,
    }),
  'shop-seller-no-shopfront.html': () =>
    shopSellerPage({
      id: f.TRADER_ID,
      seller: f.marlowe,
      listings: f.shopStock,
      origin: f.ORIGIN,
      shop: null,
    }),
  'shop-seller-empty.html': () =>
    shopSellerPage({
      id: f.TRADER_ID,
      seller: f.marlowe,
      listings: [],
      origin: f.ORIGIN,
      shop: { ...f.marloweShopClosedToday, listings_live: 0 },
    }),
  'shop-seller-hostile.html': () =>
    shopSellerPage({
      id: f.TRADER_ID,
      seller: f.marlowe,
      listings: f.shopStock,
      origin: f.ORIGIN,
      shop: f.marloweShopHostile,
    }),
  'shop-zone-mixed.html': () =>
    zonePage({
      zone: f.hounslow,
      listings: f.mixedZoneListings,
      categories: f.categories,
      origin: f.ORIGIN,
      traders: new Set([f.TRADER_ID]),
    }),
};
