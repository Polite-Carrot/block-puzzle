const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

/* Read from the module so the fake store always sells the product the game asks for. */
const PRODUCT = /var PRODUCT_ID = "([^"]+)"/.exec(fs.readFileSync('js/purchases.js', 'utf8'))[1];

/* js/purchases.js against a fake NativePurchases plugin. `owned` is what the
   store says the player owns; each test reshapes the plugin as it needs. */
function setup({ platform = 'ios', native = true, stored = null, fail = false } = {}) {
  const calls = [];
  const storage = new Map(stored === null ? [] : [['blockpuzzle.removeAds.v1', stored]]);
  const store = { owned: [], pending: false, fail };
  const plugin = {
    async getPurchases(opts) {
      calls.push(['getPurchases', opts]);
      if (store.fail) throw new Error('offline');
      const list = store.owned.map(id => ({ productIdentifier: id, purchaseState: '1' }));
      if (store.pending) list.push({ productIdentifier: PRODUCT, purchaseState: '2' });
      return { purchases: list };
    },
    async restorePurchases() { calls.push(['restorePurchases']); },
    async getProducts() { return { products: [{ identifier: PRODUCT, priceString: '£1.99', title: 'Remove Ads' }] }; },
    async purchaseProduct(opts) {
      calls.push(['purchaseProduct', opts]);
      if (store.reject) { const e = new Error(store.reject.message); e.code = store.reject.code; throw e; }
      store.owned.push(PRODUCT);
      return { productIdentifier: PRODUCT, transactionId: '1' };
    },
    async addListener(name, fn) { calls.push(['addListener', name]); store.listener = fn; },
  };
  const docListeners = [];
  const context = vm.createContext({
    console: { warn() {} }, Date, setTimeout, Promise,
    document: { visibilityState: 'visible', addEventListener: (t, fn) => docListeners.push(fn) },
    Capacitor: { isNativePlatform: () => native, getPlatform: () => platform, registerPlugin: () => plugin },
    Store: { read: k => (storage.has(k) ? storage.get(k) : null), write: (k, v) => { storage.set(k, v); return true; } },
  });
  context.window = context;
  vm.runInContext(fs.readFileSync('js/purchases.js', 'utf8'), context);
  const settle = () => new Promise(r => setImmediate(r));
  return { P: context.Purchases, plugin, store, calls, storage, settle, docListeners };
}

test('a fresh install that owns nothing shows ads and the store price', async () => {
  const f = setup();
  await f.settle(); await f.P.refresh();
  assert.equal(f.P.adsRemoved(), false);
  assert.equal(f.P.status().price, '£1.99');
});

test('buying removes ads and is remembered locally', async () => {
  const f = setup();
  await f.P.refresh();
  assert.equal(await f.P.buy(), 'owned');
  assert.equal(f.P.adsRemoved(), true);
  assert.equal(f.storage.get('blockpuzzle.removeAds.v1'), '1');
  const buy = f.calls.find(c => c[0] === 'purchaseProduct')[1];
  assert.equal(buy.productIdentifier, PRODUCT);
  assert.equal(buy.isConsumable, false);
});

test('iOS asks only for current entitlements, so refunds drop out', async () => {
  const f = setup({ stored: '1' });
  assert.equal(f.P.adsRemoved(), true, 'cache trusted at launch');
  await f.settle(); await f.P.refresh();
  assert.equal(JSON.stringify(f.calls.find(c => c[0] === 'getPurchases')[1]), '{"onlyCurrentEntitlements":true}');
  assert.equal(f.P.adsRemoved(), false, 'store says not owned (refunded) -> ads back');
  assert.equal(f.calls.some(c => c[0] === 'restorePurchases'), false, 'launch never triggers the Apple ID sheet');
});

test('a failed store query keeps the cached purchase', async () => {
  const f = setup({ stored: '1', fail: true });
  await f.settle(); await f.P.refresh();
  assert.equal(f.P.adsRemoved(), true);
});

test('cancelling says cancelled and changes nothing', async () => {
  const f = setup({ platform: 'android' });
  f.store.reject = { code: 'USER_CANCELED', message: 'Purchase is not purchased' };
  assert.equal(await f.P.buy(), 'cancelled');
  assert.equal(f.P.adsRemoved(), false);
  const g = setup();
  g.store.reject = { message: 'User cancelled' };
  assert.equal(await g.P.buy(), 'cancelled');
});

test('pending payments wait, then unlock on the next check', async () => {
  const f = setup({ platform: 'android' });
  f.store.reject = { message: 'Purchase is pending' };
  assert.equal(await f.P.buy(), 'pending');
  assert.equal(f.P.status().pending, true);
  assert.equal(f.P.adsRemoved(), false);
  f.store.owned.push(PRODUCT);
  await f.P.refresh();
  assert.equal(f.P.adsRemoved(), true);
  assert.equal(f.P.status().pending, false);
});

test('Android pending purchase found on launch shows as pending, not owned', async () => {
  const f = setup({ platform: 'android' });
  f.store.pending = true;
  await f.settle(); await f.P.refresh();
  assert.equal(f.P.adsRemoved(), false);
  assert.equal(f.P.status().pending, true);
});

test('Android launch acknowledges outstanding purchases before reading them', async () => {
  const f = setup({ platform: 'android' });
  await f.settle(); await f.P.refresh();
  const names = f.calls.map(c => c[0]);
  assert.ok(names.indexOf('restorePurchases') > -1);
  assert.ok(names.indexOf('restorePurchases') < names.indexOf('getPurchases'));
});

test('"already owned" on Android turns into a restore', async () => {
  const f = setup({ platform: 'android' });
  f.store.owned.push(PRODUCT);
  f.store.reject = { code: 'ITEM_ALREADY_OWNED', message: 'Purchase is not purchased' };
  assert.equal(await f.P.buy(), 'owned');
  assert.equal(f.P.adsRemoved(), true);
});

test('Restore finds a purchase made on another device', async () => {
  const f = setup();
  await f.settle(); await f.P.refresh();
  f.store.owned.push(PRODUCT);
  assert.equal(await f.P.restore(), true);
  assert.equal(f.P.adsRemoved(), true);
});

test('a stale query that started before the purchase cannot undo it', async () => {
  const f = setup();
  await f.settle(); await f.P.refresh();
  let release;
  const real = f.plugin.getPurchases;
  f.plugin.getPurchases = () => new Promise(r => { release = () => r({ purchases: [] }); });
  const slow = f.P.refresh();
  f.plugin.getPurchases = real;
  assert.equal(await f.P.buy(), 'owned');
  release(); await slow;
  assert.equal(f.P.adsRemoved(), true);
});

test('iOS listens for Ask to Buy approvals and refunds', async () => {
  const f = setup();
  await f.settle();
  assert.ok(f.calls.some(c => c[0] === 'addListener' && c[1] === 'transactionUpdated'));
  f.store.owned.push(PRODUCT);
  f.store.listener({}); await f.settle(); await f.settle();
  assert.equal(f.P.adsRemoved(), true);
});

test('the web build has no store', async () => {
  const f = setup({ native: false, platform: 'web' });
  assert.equal(f.P.available(), false);
  assert.equal(await f.P.buy(), 'failed');
  assert.equal(f.calls.length, 0);
});
