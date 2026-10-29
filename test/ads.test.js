const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function setup(native = true, purchases) {
  let now = 0, shows = 0, loads = 0, initOptions;
  const plugin = {
    setConsent: async () => {},
    initialize: async options => { initOptions = options; },
    prepareInterstitial: async () => { loads++; return { loaded: true }; },
    showInterstitial: async () => { shows++; return { shown: true }; },
    trackingAuthorizationStatus: async () => ({ status: 'authorized' }),
    requestTrackingAuthorization: async () => ({ status: 'authorized' }),
  };
  const context = vm.createContext({
    Date: { now: () => now }, setTimeout, clearTimeout,
    console: { warn() {} },
    Capacitor: { isNativePlatform: () => native, getPlatform: () => 'ios', registerPlugin: () => plugin },
  });
  context.window = context;
  if (purchases) context.Purchases = purchases;
  vm.runInContext(fs.readFileSync(require.resolve('@politecarrot/capacitor-unity-ads'), 'utf8'), context);
  vm.runInContext(fs.readFileSync('js/ads.js', 'utf8'), context);
  return { ads: context.Ads, plugin, time: value => { now = value; },
    counts: () => ({ shows, loads }), options: () => initOptions };
}
test('production IDs and both frequency thresholds are preserved', async () => {
  const f = setup();
  await f.ads.warm();
  assert.equal(f.options().testMode, false);
  assert.equal(f.options().gameId, '800385634');
  f.ads.noteLevelComplete(); f.ads.noteLevelComplete();
  f.time(120000);
  assert.equal(await f.ads.maybeShowInterstitial(), false);
  f.time(119999); f.ads.noteLevelComplete();
  assert.equal(await f.ads.maybeShowInterstitial(), false);
  f.time(120000);
  assert.equal(await f.ads.maybeShowInterstitial(), true);
  assert.equal(f.counts().shows, 1);
  await f.ads.warm();
  f.time(240000);
  assert.equal(await f.ads.maybeShowInterstitial(), false);
  for (let i = 0; i < 3; i++) f.ads.noteLevelComplete();
  assert.equal(await f.ads.maybeShowInterstitial(), true);
});
test('a missing preload skips the transition without waiting on load', async () => {
  const f = setup();
  let release;
  f.plugin.prepareInterstitial = () => new Promise(resolve => { release = resolve; });
  for (let i = 0; i < 3; i++) f.ads.noteLevelComplete();
  f.time(120000);
  assert.equal(await f.ads.maybeShowInterstitial(), false);
  await new Promise(resolve => setImmediate(resolve));
  release({ loaded: true });
  await f.ads.warm();
  f.plugin.prepareInterstitial = async () => ({ loaded: true });
  assert.equal(await f.ads.maybeShowInterstitial(), true);
});
test('failed presentation keeps eligibility for a later attempt', async () => {
  const f = setup();
  await f.ads.warm();
  for (let i = 0; i < 3; i++) f.ads.noteLevelComplete();
  f.time(120000);
  f.plugin.showInterstitial = async () => ({ shown: false });
  assert.equal(await f.ads.maybeShowInterstitial(), false);
  await f.ads.warm();
  f.plugin.showInterstitial = async () => ({ shown: true });
  assert.equal(await f.ads.maybeShowInterstitial(), true);
});
test('concurrent app transitions cannot show twice', async () => {
  const f = setup();
  await f.ads.warm();
  for (let i = 0; i < 3; i++) f.ads.noteLevelComplete();
  f.time(120000);
  const first = f.ads.maybeShowInterstitial();
  assert.equal(await f.ads.maybeShowInterstitial(), false);
  assert.equal(await first, true);
  assert.equal(f.counts().shows, 1);
});
test('personalization changes settle before analytics reads the result', async () => {
  const f = setup();
  await f.ads.setPersonalized(true);
  assert.equal(f.ads.adsPersonalisedGranted(), true);
  await f.ads.setPersonalized(false);
  assert.equal(f.ads.adsPersonalisedGranted(), false);
});
test('web stays playable without native ads', async () => {
  const f = setup(false);
  assert.equal(await f.ads.init(), false);
  assert.equal(await f.ads.warm(), false);
  assert.equal(await f.ads.maybeShowInterstitial(), false);
  assert.equal(f.counts().loads, 0);
});
test('Remove Ads stops Unity starting, loading and showing, and a refund brings ads back', async () => {
  let owned = true;
  const f = setup(true, { adsRemoved: () => owned });
  assert.equal(await f.ads.init(), false);
  assert.equal(await f.ads.warm(), false);
  for (let i = 0; i < 3; i++) f.ads.noteLevelComplete();
  f.time(120000);
  assert.equal(await f.ads.maybeShowInterstitial(), false);
  assert.equal(f.options(), undefined, 'Unity was never initialised');
  assert.deepEqual(f.counts(), { shows: 0, loads: 0 });
  owned = false;
  await f.ads.warm();
  for (let i = 0; i < 3; i++) f.ads.noteLevelComplete();
  assert.equal(await f.ads.maybeShowInterstitial(), true);
});
