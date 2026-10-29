"use strict";
/* "Remove Ads": one non-consumable in-app purchase, on iOS (StoreKit 2) and
 * Android (Google Play Billing), through @capgo/native-purchases. No server
 * and no account: each store keeps the record of who owns what, and the
 * phone asks it.
 *
 * PRODUCT_ID must match, character for character, the product ID created in
 * App Store Connect (In-App Purchases, type Non-Consumable) AND in Google Play
 * Console (Monetize > Products > In-app products). The price shown in the
 * game always comes from the store, in the player's own currency; there is
 * no price in this file.
 *
 * Where the answer lives:
 *   - The store is the truth. It is asked on every launch and every time the
 *     app comes back to the foreground, so a refund turns ads back on and a
 *     purchase made on another device (or approved later by a parent) turns
 *     them off without anyone pressing Restore.
 *   - OWNED_KEY in local storage is only a cache, so an offline launch does
 *     not flash an ad at someone who paid. A store query that FAILS leaves
 *     the cache alone; only a query that SUCCEEDS and does not list the
 *     product clears it.
 *   - It is a separate key from progress and prefs on purpose: "Reset
 *     progress" must never take away something the player paid for.
 *
 * The web build has no store: available() is false and the Settings rows are
 * hidden. */

(function () {
  /* Unique across the whole App Store Connect team, not just this app:
     Color Match & Merge already owns plain "remove_ads". */
  var PRODUCT_ID = "com.politecarrot.blockpuzzle.removeads";
  var OWNED_KEY = "blockpuzzle.removeAds.v1";

  var state = {
    plugin: null,
    owned: readOwned(),
    pending: false,    /* paid with a slow method, or waiting on Ask to Buy */
    product: null,     /* { priceString, title } once the store answers */
    busy: false,       /* a purchase or restore sheet is up */
    refreshing: null,
    queued: null,
    boughtAt: 0,       /* when buy() last succeeded */
  };
  var listeners = [];

  function platform() {
    try {
      var C = window.Capacitor;
      return C && C.isNativePlatform && C.isNativePlatform() ? C.getPlatform() : "web";
    } catch (e) { return "web"; }
  }

  function available() {
    var p = platform();
    return p === "ios" || p === "android";
  }

  function plugin() {
    if (state.plugin || !available()) return state.plugin;
    var C = window.Capacitor;
    if (C.registerPlugin) state.plugin = C.registerPlugin("NativePurchases");
    else if (C.Plugins) state.plugin = C.Plugins.NativePurchases;
    return state.plugin;
  }

  function readOwned() {
    try { return !!(window.Store && window.Store.read(OWNED_KEY) === "1"); }
    catch (e) { return false; }
  }

  function setOwned(on) {
    on = !!on;
    if (on) state.pending = false;
    var changed = on !== state.owned;
    state.owned = on;
    try { if (window.Store) window.Store.write(OWNED_KEY, on ? "1" : "0"); } catch (e) {}
    if (changed) emit();
  }

  function emit() {
    var snap = status();
    listeners.forEach(function (fn) { try { fn(snap); } catch (e) {} });
  }

  function status() {
    return {
      available: available(),
      owned: state.owned,
      pending: state.pending,
      busy: state.busy,
      price: state.product ? state.product.priceString : null,
    };
  }

  /* Google Play reports purchaseState as a string: "1" purchased, "2"
   * pending. StoreKit's current entitlements leave out refunded and revoked
   * purchases, so on iOS being listed is enough. */
  function findOwned(purchases) {
    var owned = false, pending = false;
    (purchases || []).forEach(function (p) {
      if (!p || p.productIdentifier !== PRODUCT_ID) return;
      if (p.revocationDate) return;
      if (platform() === "android") {
        if (p.purchaseState === "1") owned = true;
        else if (p.purchaseState === "2") pending = true;
      } else {
        owned = true;
      }
    });
    return { owned: owned, pending: pending };
  }

  /* Ask the store what this player owns. Silent: never shows a sign-in
   * sheet. (Restore, below, is the one that may.) */
  function refresh() {
    var NP = plugin();
    if (!NP) return Promise.resolve(status());
    /* One query at a time; a call that arrives during one runs again after
     * it, so a caller never gets an answer to a question asked before
     * whatever it is reacting to (a purchase completing, an app resume). */
    if (state.refreshing) {
      if (!state.queued) {
        state.queued = state.refreshing.then(function () {
          state.queued = null;
          return refresh();
        });
      }
      return state.queued;
    }
    var askedAt = Date.now();
    state.refreshing = (async function () {
      try {
        if (platform() === "android") {
          /* Picks up purchases that finished while the app was closed (a
           * pending payment that cleared) and acknowledges them. Google
           * refunds any purchase left unacknowledged for three days. On
           * Android this shows nothing to the player. */
          try { await NP.restorePurchases(); } catch (e) {}
        }
        var res = await NP.getPurchases(
          platform() === "ios"
            ? { onlyCurrentEntitlements: true }
            : { productType: "inapp" }
        );
        var found = findOwned(res && res.purchases);
        /* A query sent before a purchase finished can come back after it,
         * without the purchase in it. That answer is stale; ignore it. */
        if (!found.owned && state.boughtAt >= askedAt) return status();
        state.pending = !found.owned && found.pending;
        setOwned(found.owned);
        emit();
      } catch (e) {
        /* Offline, or the store is having a moment: keep what we had. */
        console.warn("Purchases: could not ask the store:", e && e.message);
      } finally {
        state.refreshing = null;
      }
      return status();
    })();
    return state.refreshing;
  }

  async function loadProduct() {
    var NP = plugin();
    if (!NP || state.product) return state.product;
    try {
      var res = await NP.getProducts({ productIdentifiers: [PRODUCT_ID], productType: "inapp" });
      var p = res && res.products && res.products[0];
      if (p) { state.product = { priceString: p.priceString, title: p.title }; emit(); }
      else console.warn("Purchases: the store has no product called " + PRODUCT_ID);
    } catch (e) {
      console.warn("Purchases: could not load the product:", e && e.message);
    }
    return state.product;
  }

  /* Resolves to one of:
   *   'owned'     bought now, or already owned (ads are off)
   *   'pending'   waiting on payment or a parent's approval; ads turn off
   *               by themselves once it completes
   *   'cancelled' the player closed the sheet; say nothing
   *   'failed'    anything else */
  async function buy() {
    var NP = plugin();
    if (!NP) return "failed";
    if (state.owned) return "owned";
    if (state.busy) return "failed";
    state.busy = true; emit();
    try {
      var tx = await NP.purchaseProduct({
        productIdentifier: PRODUCT_ID,
        productType: "inapp",
        isConsumable: false,
      });
      if (tx && tx.productIdentifier === PRODUCT_ID) {
        state.boughtAt = Date.now();
        setOwned(true);
      }
      else await refresh();
      return state.owned ? "owned" : "failed";
    } catch (e) {
      var text = ((e && e.code) || "") + " " + ((e && e.message) || "");
      if (/USER_CANCEL|cancel/i.test(text)) return "cancelled";
      if (/pending/i.test(text)) { state.pending = true; emit(); return "pending"; }
      if (/ITEM_ALREADY_OWNED/i.test(text)) { await refresh(); return state.owned ? "owned" : "failed"; }
      console.warn("Purchases: purchase failed:", text);
      return "failed";
    } finally {
      state.busy = false; emit();
    }
  }

  /* The Restore button, which Apple requires for anything bought once. On
   * iOS this syncs with the App Store and may ask for the Apple ID password,
   * which is why it is never called without a tap. Resolves to true if the
   * player owns Remove Ads afterwards. */
  async function restore() {
    var NP = plugin();
    if (!NP) return false;
    if (state.busy) return state.owned;
    state.busy = true; emit();
    try {
      try { await NP.restorePurchases(); } catch (e) {
        console.warn("Purchases: restore failed:", e && e.message);
      }
      await refresh();
      return state.owned;
    } finally {
      state.busy = false; emit();
    }
  }

  function onChange(fn) { listeners.push(fn); }

  function start() {
    var NP = plugin();
    if (!NP) return;
    /* iOS tells us about purchases that complete outside the buy() call:
     * Ask to Buy approvals, purchases on another device, refunds. Re-asking
     * the store is simpler and safer than interpreting each event. */
    if (platform() === "ios" && NP.addListener) {
      try { NP.addListener("transactionUpdated", function () { refresh(); }); } catch (e) {}
    }
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && !state.busy) refresh();
    });
    refresh();
    loadProduct();
  }

  window.Purchases = {
    PRODUCT_ID: PRODUCT_ID,
    available: available,
    adsRemoved: function () { return state.owned; },
    status: status,
    buy: buy,
    restore: restore,
    refresh: refresh,
    loadProduct: loadProduct,
    onChange: onChange,
  };

  start();
})();
