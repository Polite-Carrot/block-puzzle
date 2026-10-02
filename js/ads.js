"use strict";
/* App-specific Unity configuration and frequency policy. SDK lifecycle,
 * consent signals, ATT and playback live in the shared package. */
(function () {
  var client = window.PoliteCarrotAds.createUnityAds({
    ios: { gameId: "800385634", interstitial: "BP_Interstitial_iOS" },
    android: { gameId: "800385636", interstitial: "BP_Interstitial_Android" },
    testMode: false,
  });
  var MIN_MILLIS = 2 * 60 * 1000;
  var MIN_LEVELS = 3;
  var lastShownAt = Date.now();
  var levelsSinceLast = 0;
  var preparing = null;
  var showing = false;
  var attPromise = null;

  function getPlatform() { return client.state().platform; }
  function isNative() { return getPlatform() === 'ios' || getPlatform() === 'android'; }
  function warn(error) { console.warn('Ads:', error && error.message || error); }
  function track(name, params) {
    if (window.Track) window.Track.event(name, params);
  }

  function warm() {
    if (!isNative() || showing) return Promise.resolve(false);
    if (preparing) return preparing;
    preparing = client.prepareInterstitial().then(function (result) {
      if (!result.loaded) warn(result.reason);
      return result.loaded === true;
    }).catch(function (error) {
      warn(error);
      return false;
    }).finally(function () { preparing = null; });
    return preparing;
  }

  function noteLevelComplete() {
    if (!isNative()) return;
    levelsSinceLast += 1;
    if (levelsSinceLast >= MIN_LEVELS - 1 && !client.state().prepared.interstitial) warm();
  }

  async function maybeShowInterstitial() {
    if (!isNative() || showing || levelsSinceLast < MIN_LEVELS ||
        Date.now() - lastShownAt < MIN_MILLIS) return false;
    // Never wait for an ad to load in the Next Level button handler.
    if (!client.state().prepared.interstitial) { warm(); return false; }
    showing = true;
    try {
      var result = await client.showInterstitial();
      if (!result.shown) { warn(result.reason); track('ad_skipped', { reason: String(result.reason || 'unknown') }); return false; }
      lastShownAt = Date.now();
      levelsSinceLast = 0;
      track('ad_shown', { format: 'interstitial', platform: getPlatform() });
      return true;
    } catch (error) {
      warn(error);
      track('ad_failed', { format: 'interstitial' });
      return false;
    } finally {
      showing = false;
      warm();
    }
  }

  async function setPersonalized(on) {
    try {
      if (client.state().personalized !== (on === true)) {
        await client.setPersonalized(on === true);
      }
      if (isNative() && client.state().ready) warm();
    } catch (error) { warn(error); }
  }

  function ensureAtt(mayPrompt) {
    if (getPlatform() !== 'ios') return Promise.resolve(null);
    if (attPromise) return attPromise;
    // Prompt only from the app's existing onboarding/settings actions.
    attPromise = (mayPrompt ? client.requestTracking() : client.init().then(function () {
      return client.state().attStatus;
    })).catch(function (error) {
      warn(error);
      return null;
    }).finally(function () { attPromise = null; });
    return attPromise;
  }

  function adsPersonalisedGranted() { return client.state().effectivePersonalized; }

  window.Ads = {
    init: client.init,
    isNative: isNative,
    getPlatform: getPlatform,
    setPersonalized: setPersonalized,
    ensureAtt: ensureAtt,
    requestTracking: function () { return ensureAtt(true); },
    adsPersonalisedGranted: adsPersonalisedGranted,
    noteLevelComplete: noteLevelComplete,
    maybeShowInterstitial: maybeShowInterstitial,
    warm: warm,
    consentState: client.state,
  };
  window.__consentDebug = function () {
    var state = client.state();
    return { attStatus: state.attStatus, personalizedAds: state.personalized,
      unityConsent: state.effectivePersonalized, granted: state.effectivePersonalized };
  };
})();
