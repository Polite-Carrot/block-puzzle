/* ads.js — AdMob interstitial wrapper.
 *
 * Only interstitials are used. Frequency cap:
 *   at least two minutes AND three level completions since the last one.
 *
 * The module is a no-op on the web build (no window.Capacitor), so
 * index.html still opens cleanly in a browser during development.
 *
 * Ad unit + app IDs are production. Google's official test IDs are kept
 * commented out for local dev. isTestAdId() below autodetects Google's
 * test-publisher prefix and turns SDK-side test mode on/off from that alone. */

(function () {
  var INTERSTITIAL_IDS = {
    // android: 'ca-app-pub-3940256099942544/1033173712',
    // ios:     'ca-app-pub-3940256099942544/4411468910',
    android: 'ca-app-pub-2022992563510125/2449650427',
    ios:     'ca-app-pub-2022992563510125/8646168354'
  };

  var MIN_MILLIS = 2 * 60 * 1000;   /* two minutes between ads */
  var MIN_LEVELS = 3;               /* three level completions between ads */

  var TEST_PUBLISHER_PREFIX = 'ca-app-pub-3940256099942544';
  function isTestAdId(id) {
    return typeof id === 'string' && id.indexOf(TEST_PUBLISHER_PREFIX) === 0;
  }

  /* Force EEA/NOT_EEA for QA on a device outside the EEA. null in shipped builds. */
  var DEBUG_GEOGRAPHY = null;

  var state = {
    plugin: null,
    ready: false,
    initializing: null,
    platform: null,
    interstitialId: null,
    personalized: false,
    adConsentResolved: false,
    adConsent: { canRequestAds: true, npa: false, canChange: false },
    attStatus: null,
    attPromise: null,
    umpPromise: null
  };

  var freq = {
    /* Count from module load so the first ad cannot fire inside the opening
       two minutes of play. */
    lastShownAt: Date.now(),
    levelsSinceLast: 0,
    prepared: false,
    preparing: null
  };

  function isNative() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  function getPlatform() {
    try { return window.Capacitor.getPlatform(); } catch (e) { return null; }
  }

  function getPlugin() {
    if (state.plugin) return state.plugin;
    if (!window.Capacitor) return null;
    if (window.Capacitor.registerPlugin) {
      state.plugin = window.Capacitor.registerPlugin('AdMob');
    } else if (window.Capacitor.Plugins && window.Capacitor.Plugins.AdMob) {
      state.plugin = window.Capacitor.Plugins.AdMob;
    }
    return state.plugin;
  }

  async function init() {
    if (!isNative()) return false;
    if (state.ready) return true;
    if (state.initializing) return state.initializing;

    var AdMob = getPlugin();
    if (!AdMob) {
      console.warn('Ads: AdMob plugin proxy unavailable');
      return false;
    }
    state.platform = getPlatform();
    state.interstitialId = INTERSTITIAL_IDS[state.platform] || INTERSTITIAL_IDS.android;

    state.initializing = (async function () {
      try {
        await AdMob.initialize({ initializeForTesting: isTestAdId(state.interstitialId) });
      } catch (e) {
        console.warn('Ads: initialize failed:', e && e.message);
        state.ready = false;
        state.initializing = null;
        return false;
      }
      state.ready = true;
      console.info('Ads: initialised on', state.platform,
        isTestAdId(state.interstitialId) ? '(test mode)' : '(production)');
      return true;
    })();
    return state.initializing;
  }

  /* UMP consent form. If no message is published, this is a no-op. */
  async function runUmp(refresh) {
    var AdMob = getPlugin();
    if (!AdMob || !isNative() || !AdMob.requestConsentInfo) return state.adConsent;
    if (refresh) state.umpPromise = null;
    if (state.umpPromise) return state.umpPromise;
    state.umpPromise = (async function () {
      try {
        var opts = {};
        if (DEBUG_GEOGRAPHY) opts.debugGeography = DEBUG_GEOGRAPHY;
        var info = await AdMob.requestConsentInfo(opts);
        if (info && info.status === 'REQUIRED' && info.isConsentFormAvailable) {
          try { info = (await AdMob.showConsentForm()) || info; } catch (e) {}
        }
        state.adConsent = {
          canRequestAds: !info || info.canRequestAds !== false,
          npa: !(info && (info.status === 'OBTAINED' || info.status === 'NOT_REQUIRED')),
          canChange: !!(info && info.privacyOptionsRequirementStatus === 'REQUIRED')
        };
        state.adConsentResolved = true;
      } catch (e) {
        state.adConsent = { canRequestAds: true, npa: true, canChange: false };
        state.adConsentResolved = true;
      }
      return state.adConsent;
    })();
    return state.umpPromise;
  }

  /* Apple's ATT prompt. Fired from a tap, never at cold launch: the prompt
     cannot display until the app is active and the window is key, and an
     early call silently no-ops leaving the status at notDetermined forever
     — it appears once per install. Android has no ATT and returns before
     touching the plugin. */
  async function ensureAtt(mayPrompt) {
    var AdMob = getPlugin();
    if (!AdMob || !isNative()) return null;
    if (getPlatform() === 'android') return null;
    if (state.attPromise) return state.attPromise;
    state.attPromise = (async function () {
      try {
        var tt = await AdMob.trackingAuthorizationStatus();
        state.attStatus = (tt && tt.status) || 'notDetermined';
        if (state.attStatus === 'notDetermined' && mayPrompt) {
          await AdMob.requestTrackingAuthorization();
          tt = await AdMob.trackingAuthorizationStatus();
          state.attStatus = (tt && tt.status) || state.attStatus;
        }
      } catch (e) {
        state.attStatus = 'denied';
      }
      return state.attStatus;
    })();
    return state.attPromise;
  }

  function requestTracking() { return ensureAtt(true); }

  /* What is ACTUALLY happening, as opposed to what was stored. A switch
     reading "On" would be a lie if iOS or the UMP form has denied tracking. */
  function adsPersonalisedGranted() {
    if (!state.adConsentResolved || !state.personalized) return false;
    if (getPlatform() === 'ios' && state.attStatus !== 'authorized') return false;
    return !state.adConsent.npa;
  }

  function adNpa() {
    return !state.adConsentResolved || !state.personalized || state.adConsent.npa ||
      (getPlatform() === 'ios' && state.attStatus !== 'authorized');
  }

  async function prepareInterstitial() {
    if (!(await init())) return false;
    if (state.adConsentResolved && !state.adConsent.canRequestAds) return false;
    if (freq.prepared) return true;
    if (freq.preparing) return freq.preparing;

    freq.preparing = (async function () {
      try {
        var opts = {
          adId: state.interstitialId,
          isTesting: isTestAdId(state.interstitialId)
        };
        opts.npa = adNpa();
        await state.plugin.prepareInterstitial(opts);
        freq.prepared = true;
        return true;
      } catch (e) {
        console.warn('Ads: prepareInterstitial failed', e && e.message);
        freq.prepared = false;
        return false;
      } finally {
        freq.preparing = null;
      }
    })();
    return freq.preparing;
  }

  /* Called once per level completed. If the player is one level short of the
     threshold, prepare the next ad in the background. */
  function noteLevelComplete() {
    if (!isNative()) return;
    freq.levelsSinceLast += 1;
    if (freq.levelsSinceLast >= MIN_LEVELS - 1 && !freq.prepared && !freq.preparing) {
      prepareInterstitial();
    }
  }

  /* If both conditions are met, shows the interstitial and resets the
     counters. Always returns a Promise so callers can await uniformly. */
  async function maybeShowInterstitial() {
    if (!isNative()) return false;
    var enoughTime = Date.now() - freq.lastShownAt >= MIN_MILLIS;
    var enoughLevels = freq.levelsSinceLast >= MIN_LEVELS;
    if (!enoughTime || !enoughLevels) return false;

    if (!freq.prepared && !(await prepareInterstitial())) return false;

    try {
      await state.plugin.showInterstitial();
      freq.lastShownAt = Date.now();
      freq.levelsSinceLast = 0;
      freq.prepared = false;
      prepareInterstitial();
      return true;
    } catch (e) {
      console.warn('Ads: showInterstitial failed', e && e.message);
      freq.prepared = false;
      return false;
    }
  }

  /* Warming up the first interstitial. Wait for the caller — booting through
     init() while the app is drawing its first frame stalls the initial paint
     on some devices. Nothing is lost by waiting: the first interstitial
     cannot show until three levels are done and two minutes have passed. */
  function warm() {
    if (!isNative()) return Promise.resolve(false);
    return init().then(function (ok) {
      return ok ? prepareInterstitial() : false;
    }, function () { return false; });
  }

  /* Called from the privacy dialog. If the flag flips, any ad already warmed
     was requested under the old one and is no longer appropriate: drop it and
     prepare a fresh one. */
  function setPersonalized(on) {
    var next = !!on;
    if (state.personalized === next) return;
    state.personalized = next;
    if (!isNative()) return;
    freq.prepared = false;
    prepareInterstitial();
  }

  window.Ads = {
    init: init,
    isNative: isNative,
    getPlatform: getPlatform,
    runUmp: runUmp,
    ensureAtt: ensureAtt,
    requestTracking: requestTracking,
    warm: warm,
    noteLevelComplete: noteLevelComplete,
    maybeShowInterstitial: maybeShowInterstitial,
    setPersonalized: setPersonalized,
    showPrivacyOptionsForm: async function () {
      var AdMob = getPlugin();
      if (!AdMob || !AdMob.showPrivacyOptionsForm) return false;
      await AdMob.showPrivacyOptionsForm();
      await runUmp(true);
      return true;
    },
    adsPersonalisedGranted: adsPersonalisedGranted,
    adNpa: adNpa
  };

  window.__consentDebug = function () {
    return {
      adConsentResolved: state.adConsentResolved,
      adConsent: state.adConsent,
      attStatus: state.attStatus,
      personalizedAds: state.personalized,
      granted: adsPersonalisedGranted()
    };
  };
})();
