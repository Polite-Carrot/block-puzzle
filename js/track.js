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
           not an array — four separate awaits to grant/deny each type. */
        await fb.setConsent({ type: 'ANALYTICS_STORAGE',  status: 'GRANTED' });
        await fb.setConsent({ type: 'AD_STORAGE',         status: adStatus });
        await fb.setConsent({ type: 'AD_USER_DATA',       status: adStatus });
        await fb.setConsent({ type: 'AD_PERSONALIZATION', status: adStatus });
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
        await fb.setConsent({ type: 'ANALYTICS_STORAGE',  status: 'DENIED' });
        await fb.setConsent({ type: 'AD_STORAGE',         status: 'DENIED' });
        await fb.setConsent({ type: 'AD_USER_DATA',       status: 'DENIED' });
        await fb.setConsent({ type: 'AD_PERSONALIZATION', status: 'DENIED' });
      }
    } catch (e) { /* nothing to do */ }
    enabled = false;
  }

  /* Reads the consent state that app.js publishes on window.__consentState.
     Called from the app whenever a toggle changes. */
  function sync() {
    var choice = global.__consentState || {};
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
