/* track.js — optional, consented analytics.
 *
 * Native-only wrapper around @capacitor-firebase/analytics. On the web build
 * there is no measurement id set, so every call is a no-op — the file exists
 * so app.js can call Track.event() unconditionally.
 *
 * Nothing runs until the player has said yes in Settings. GA4 writes a
 * Firebase install id, which UK PECR and GDPR require consent for BEFORE
 * anything is stored — which is why native SDK collection defaults to OFF
 * (see AndroidManifest.xml and Info.plist flags) and Track.load() is only
 * called after the toggle is on.
 *
 * Every call is safe to make at any time. Before consent, or with no plugin
 * registered, event() does nothing and throws nothing: a tracking failure
 * must never cost somebody their game. */

(function (global) {
  'use strict';

  var enabled = false;

  function isNative() { return !!global.Capacitor; }

  function configured() {
    return isNative() && !!firebasePlugin();
  }

  var _fb = null;
  function firebasePlugin() {
    if (_fb) return _fb;
    if (!global.Capacitor) return null;
    if (global.Capacitor.registerPlugin) {
      _fb = global.Capacitor.registerPlugin('FirebaseAnalytics');
    } else if (global.Capacitor.Plugins && global.Capacitor.Plugins.FirebaseAnalytics) {
      _fb = global.Capacitor.Plugins.FirebaseAnalytics;
    }
    return _fb;
  }

  /* Last status pushed per consent type. ATT resolving after boot flips only
     the ad grants, so without this the analytics grant is re-sent unchanged. */
  var applied = {};

  async function push(fb, type, status) {
    if (applied[type] === status) return;
    await fb.setConsent({ type: type, status: status });
    applied[type] = status;
  }

  /* Turn collection on: after consent, or after somebody flips the setting
     back on. Safe to call repeatedly.

     adsAllowed: pass false when the user has not consented to personalised
     ads, so ad-related Consent Mode v2 grants are DENIED even while
     ANALYTICS_STORAGE is GRANTED. Defaults to true. */
  async function load(adsAllowed) {
    if (!configured()) return;
    enabled = true;
    var fb = firebasePlugin();
    if (!fb) return;
    var adStatus = adsAllowed === false ? 'DENIED' : 'GRANTED';
    try {
      await fb.setEnabled({ enabled: true });
      if (fb.setConsent) {
        /* @capacitor-firebase/analytics 8.x takes { type, status } per call,
           not an array — one await per type. */
        await push(fb, 'ANALYTICS_STORAGE',  'GRANTED');
        await push(fb, 'AD_STORAGE',         adStatus);
        await push(fb, 'AD_USER_DATA',       adStatus);
        await push(fb, 'AD_PERSONALIZATION', adStatus);
      }
    } catch (e) {
      console.warn('Track: Firebase enable failed', e && e.message);
    }
  }

  async function unload() {
    if (!configured()) { enabled = false; return; }
    var fb = firebasePlugin();
    if (!fb) { enabled = false; return; }
    try {
      await fb.setEnabled({ enabled: false });
      if (fb.setConsent) {
        await push(fb, 'ANALYTICS_STORAGE',  'DENIED');
        await push(fb, 'AD_STORAGE',         'DENIED');
        await push(fb, 'AD_USER_DATA',       'DENIED');
        await push(fb, 'AD_PERSONALIZATION', 'DENIED');
      }
    } catch (e) { /* nothing to do */ }
    enabled = false;
  }

  /* Reads the consent state that app.js publishes on window.__consentState.
     Called from the app whenever a toggle changes.

     Boot calls this three times over (startup, consent check, then again once
     ATT and the ads SDK have settled), and each pass costs four native
     setConsent round-trips. Remembering the last state applied makes the
     repeats free without the callers needing to know about each other. */
  var lastSynced = null;
  function sync(force) {
    var choice = global.__consentState || {};
    var key = (choice.analytics === true) + '/' + (choice.ads === true);
    if (!force && key === lastSynced) return;
    /* Only remember a state that actually reached the plugin, so a sync that
       ran before the plugin registered does not suppress the real one. */
    lastSynced = configured() ? key : null;
    if (choice.analytics === true) load(choice.ads === true);
    else unload();
  }

  function event(name, params) {
    if (!enabled) return;
    if (!configured()) return;
    var fb = firebasePlugin();
    if (!fb) return;
    /* Firebase Analytics parameter names are limited to 40 chars and values
       to 100. Trim quietly rather than reject. */
    var safe = {};
    if (params) for (var k in params) {
      if (Object.prototype.hasOwnProperty.call(params, k)) {
        if (params[k] === undefined || params[k] === null) continue;
        safe[String(k).slice(0, 40)] = typeof params[k] === 'string'
          ? params[k].slice(0, 100) : params[k];
      }
    }
    /* The Capacitor bridge log only prints the callback id, so set
       window.__trackDebug = true in the Web Inspector to see what is sent. */
    if (global.__trackDebug) console.log('Track event:', name, JSON.stringify(safe));
    try { fb.logEvent({ name: name, params: safe }).catch(function () {}); }
    catch (e) { /* analytics must never break play */ }
  }

  global.Track = {
    configured: configured,
    load: load,
    sync: sync,
    unload: unload,
    event: event,
    get id() { return isNative() ? 'firebase' : ''; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
