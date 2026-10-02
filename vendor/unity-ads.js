/* CommonJS + plain-script entry point. No bundler or runtime dependency. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PoliteCarrotAds = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createUnityAds(options = {}) {
    const capacitor = options.capacitor || globalThis.Capacitor;
    const native = !!(capacitor && capacitor.isNativePlatform && capacitor.isNativePlatform());
    const platform = native ? capacitor.getPlatform() : 'web';
    const config = options[platform];
    const plugin = native ? (capacitor.registerPlugin
      ? capacitor.registerPlugin('UnityAds') : capacitor.Plugins && capacitor.Plugins.UnityAds) : null;
    const timeoutMs = options.timeoutMs === undefined ? 12000 : options.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
    if (native && (!config || !config.gameId)) throw new Error('Missing Unity gameId for ' + platform);
    let ready = false, personalized = false, attStatus = null, appliedConsent = null;
    let queue = Promise.resolve(), showing = false;
    let consentRevision = 0, syncedRevision = -1;
    const prepared = { interstitial: false, rewarded: false };

    function serialize(task) {
      const result = queue.then(task);
      queue = result.catch(() => {});
      return result;
    }
    async function deadline(task) {
      let timer;
      try {
        return await Promise.race([
          task,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('native call timed out')), timeoutMs); })
        ]);
      } finally { clearTimeout(timer); }
    }
    function errorResult(error) {
      return { shown: false, rewarded: false, reason: error && error.message || String(error),
        ...(error && error.code !== undefined ? { code: error.code } : {}) };
    }
    async function syncConsent() {
      const revision = consentRevision;
      // Read ATT again so an answer changed in iOS Settings takes effect.
      if (platform === 'ios') {
        const result = await deadline(plugin.trackingAuthorizationStatus());
        attStatus = result.status;
      }
      const granted = personalized && (platform !== 'ios' || attStatus === 'authorized');
      if (appliedConsent !== granted) {
        prepared.interstitial = prepared.rewarded = false;
        // A failed/timed-out bridge call may still have changed native state.
        appliedConsent = null;
        await deadline(plugin.setConsent({ granted }));
        appliedConsent = granted;
      }
      if (revision !== consentRevision) return syncConsent();
      syncedRevision = revision;
    }
    async function initialize() {
      await syncConsent(); // A failed consent update prevents the request.
      if (ready) return;
      await deadline(plugin.initialize({ gameId: config.gameId, testMode: options.testMode !== false }));
      ready = true;
    }
    async function prepare(format) {
      if (!native) return { loaded: false, reason: 'web' };
      const placementId = config[format];
      if (!placementId) return { loaded: false, reason: 'placement not configured' };
      try {
        await initialize();
        // A preference may have changed while SDK initialization was pending.
        if (syncedRevision !== consentRevision) await syncConsent();
        const revision = consentRevision;
        const method = format === 'interstitial' ? 'prepareInterstitial' : 'prepareRewarded';
        // Ask native even if previously loaded: it also knows about expiry.
        const result = await deadline(plugin[method]({ placementId }));
        if (revision !== consentRevision) {
          prepared[format] = false;
          return { loaded: false, reason: 'consent changed during load' };
        }
        prepared[format] = result.loaded === true;
        return result;
      } catch (error) {
        prepared[format] = false;
        const { reason, code } = errorResult(error);
        return { loaded: false, reason, ...(code !== undefined ? { code } : {}) };
      }
    }
    function show(format) {
      if (!native) return Promise.resolve({ shown: false, rewarded: false, reason: 'web' });
      if (showing) return Promise.resolve({ shown: false, rewarded: false, reason: 'already showing' });
      showing = true;
      return serialize(async () => {
        try {
          await syncConsent();
          if (syncedRevision !== consentRevision || !prepared[format]) {
            return { shown: false, rewarded: false, reason: 'not prepared' };
          }
          prepared[format] = false;
          const method = format === 'interstitial' ? 'showInterstitial' : 'showRewarded';
          // Never timeout a visible native ad in JS: that would leave its
          // controller covering a game that incorrectly thinks playback ended.
          const result = await plugin[method]();
          return { ...result, rewarded: format === 'rewarded' && result.rewarded === true };
        } catch (error) { return errorResult(error); }
        finally { showing = false; }
      });
    }
    return {
      init: () => serialize(async () => {
        if (!native) return false;
        try { await initialize(); return true; } catch (_) { return false; }
      }),
      setPersonalized: (value) => {
        personalized = value === true;
        consentRevision++;
        // Invalidate immediately, even while another native operation is pending.
        prepared.interstitial = prepared.rewarded = false;
        return serialize(async () => {
          if (!native) return;
          await syncConsent();
        });
      },
      requestTracking: () => serialize(async () => {
        if (platform !== 'ios') return 'notApplicable';
        const status = await plugin.requestTrackingAuthorization();
        attStatus = status.status;
        await syncConsent();
        return attStatus;
      }),
      prepareInterstitial: () => serialize(() => prepare('interstitial')),
      prepareRewarded: () => serialize(() => prepare('rewarded')),
      showInterstitial: () => show('interstitial'),
      showRewarded: () => show('rewarded'),
      state: () => ({ platform, ready, showing, personalized, attStatus,
        effectivePersonalized: appliedConsent === true, prepared: { ...prepared } })
    };
  }
  return { createUnityAds };
});
