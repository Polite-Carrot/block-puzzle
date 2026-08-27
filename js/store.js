/* store.js — somewhere to keep progress that survives closing the game.
 *
 * localStorage is the right place for this: progress belongs to the person
 * playing, not to everyone who opens the page. But it is not guaranteed to be
 * there. A private window, an embedded view, or a browser set to block site
 * data can each refuse it — sometimes by throwing, and sometimes, worse, by
 * accepting a write and keeping nothing.
 *
 * So the backend is chosen by testing it rather than assuming it: write a
 * probe, read it back, and only trust it if the value survives the round trip.
 * Whatever is chosen, the game says so on the menu rather than quietly losing
 * someone's stars. */
(function (global) {
  'use strict';

  var PROBE = 'blockpuzzle.probe';

  function survivesRoundTrip(store) {
    if (!store) return false;
    try {
      var stamp = String(Date.now());
      store.setItem(PROBE, stamp);
      var back = store.getItem(PROBE) === stamp;
      store.removeItem(PROBE);
      return back;
    } catch (e) {
      return false;                 /* blocked outright */
    }
  }

  /* Last resort. Keeps the game working for one sitting, and is honest that
     nothing will be there next time. */
  function inMemory() {
    var held = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(held, k) ? held[k] : null; },
      setItem: function (k, v) { held[k] = String(v); },
      removeItem: function (k) { delete held[k]; }
    };
  }

  function choose() {
    try {
      if (survivesRoundTrip(global.localStorage)) return { store: global.localStorage, kind: 'kept' };
    } catch (e) { /* touching it can throw before it is even used */ }
    try {
      if (survivesRoundTrip(global.sessionStorage)) return { store: global.sessionStorage, kind: 'this-visit' };
    } catch (e) { /* ditto */ }
    return { store: inMemory(), kind: 'not-kept' };
  }

  var chosen = choose();

  global.Store = {
    /* 'kept'       — survives closing the game
       'this-visit' — lasts until the tab closes
       'not-kept'   — nothing is being stored at all */
    kind: chosen.kind,
    survivesClosing: chosen.kind === 'kept',

    read: function (key) {
      try { return chosen.store.getItem(key); } catch (e) { return null; }
    },

    /* Reports whether the value is genuinely there afterwards, so a caller can
       tell the difference between saved and only apparently saved. */
    write: function (key, value) {
      try {
        chosen.store.setItem(key, value);
        return chosen.store.getItem(key) === value;
      } catch (e) {
        return false;
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
