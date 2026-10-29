"use strict";
/* Daily puzzle reminders, as LOCAL notifications (@capacitor/local-notifications).
 *
 * The daily puzzle is built on the phone from the date, so the phone can also
 * schedule its own reminder: no push server, no Firebase Cloud Messaging, no
 * APNs keys, and nothing leaves the device.
 *
 * How it schedules: not one repeating alarm, because a repeating alarm cannot
 * skip a day. Instead the next DAYS_AHEAD days are scheduled one by one, and
 * every time the game opens, comes back to the foreground or a daily is
 * solved, all of them are cancelled and rescheduled from scratch. So:
 *   - today's reminder is dropped as soon as today's puzzle is solved;
 *   - the wording can mention the streak, and is always true when it fires;
 *   - someone who stops playing hears from us for a week and then not again.
 *
 * Permission is asked once on first run, right after Apple's tracking prompt
 * (primeConsent in js/app.js). iOS shows that prompt once per install and
 * Android at most twice, so after a refusal, switching reminders on opens the
 * phone's notification settings instead. */

(function () {
  var PREF_KEY = "blockpuzzle.reminders.v1";
  var CHANNEL = "daily";
  var FIRST_ID = 7100; /* ids 7100..7100+DAYS_AHEAD-1 belong to this module */
  var DAYS_AHEAD = 7;
  var DEFAULT_HOUR = 18; 
  var plugin = null;
  var openHandler = null;
  var channelMade = false;
  var lastDone = {};

  /* on:    true once the player has said yes; false if they turned it off
   * asked: the after-first-daily offer has been shown (shown once only)
   * hour:  0-23, local time */
  var prefs = load();

  function load() {
    var p = { on: false, asked: false, hour: DEFAULT_HOUR };
    try {
      var raw = window.Store && window.Store.read(PREF_KEY);
      if (raw) {
        var v = JSON.parse(raw);
        p.on = v.on === true;
        p.asked = v.asked === true;
        if (typeof v.hour === "number" && v.hour >= 0 && v.hour <= 23)
          p.hour = v.hour;
      }
    } catch (e) {}
    return p;
  }

  function save() {
    try {
      window.Store.write(PREF_KEY, JSON.stringify(prefs));
    } catch (e) {}
  }

  function platform() {
    try {
      var C = window.Capacitor;
      return C && C.isNativePlatform && C.isNativePlatform()
        ? C.getPlatform()
        : "web";
    } catch (e) {
      return "web";
    }
  }

  function available() {
    var p = platform();
    return p === "ios" || p === "android";
  }

  function getPlugin() {
    if (plugin || !available()) return plugin;
    var C = window.Capacitor;
    if (C.registerPlugin) plugin = C.registerPlugin("LocalNotifications");
    else if (C.Plugins) plugin = C.Plugins.LocalNotifications;
    return plugin;
  }

  /* 'granted' | 'denied' | 'prompt' | 'unavailable' */
  async function permission() {
    var LN = getPlugin();
    if (!LN) return "unavailable";
    try {
      var r = await LN.checkPermissions();
      if (r.display === "granted") return "granted";
      if (r.display === "denied") return "denied";
      return "prompt";
    } catch (e) {
      return "unavailable";
    }
  }

  async function ensureChannel() {
    if (channelMade || platform() !== "android") return;
    try {
      await getPlugin().createChannel({
        id: CHANNEL,
        name: "Daily puzzle",
        description: "A reminder when the daily puzzle is ready",
        importance: 3,
      });
      channelMade = true;
    } catch (e) {
      console.warn("Reminders: channel failed:", e && e.message);
    }
  }

  /* Counted from the day keys plan() is given; this game's Daily.streak reads
     calendar ids instead. A day not yet played does not break the run. */
  function streakFrom(done, from) {
    var D = window.Daily, d = from, n = 0;
    if (!done[D.key(d)]) d = D.shift(d, -1);
    while (done[D.key(d)]) { n++; d = D.shift(d, -1); }
    return n;
  }

  /* The notifications to schedule, given the solved-days record. Pure, so it
   * can be tested without a phone. */
  function plan(done, now) {
    var D = window.Daily;
    now = now || new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var todayDone = !!done[D.key(today)];
    /* Streak still alive at the moment today's reminder fires. */
    var streakNow = streakFrom(done, today);
    var out = [];
    for (var i = 0; i < DAYS_AHEAD; i++) {
      var day = D.shift(today, i);
      if (i === 0 && todayDone) continue;
      var at = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        prefs.hour,
        0,
        0,
      );
      if (at <= now) continue;
      /* The streak can only be quoted for the next reminder to fire: by the
         one after, the player may have missed a day in between. Today (if
         unsolved) or tomorrow (if today is solved). */
      var next = todayDone ? i === 1 : i === 0;
      var body =
        next && streakNow >= 2
          ? "Your daily puzzle is ready. Keep your " +
            streakNow +
            "-day streak alive! \uD83D\uDD25"
          : "A new daily puzzle is ready.";
      out.push({
        id: FIRST_ID + i,
        title: "Daily puzzle",
        body: body,
        schedule: { at: at, allowWhileIdle: true },
        /* Inexact: a reminder a few minutes late is fine, and asking for
           exact alarms sends Android 12+ players to a system settings page. */
        isExactNotification: false,
        channelId: CHANNEL,
        smallIcon: "ic_stat_daily",
        iconColor: "#FF5D8F",
        extra: { kind: "daily", day: D.key(day) },
      });
    }
    return out;
  }

  async function cancelAll() {
    var LN = getPlugin();
    if (!LN) return;
    var ids = [];
    for (var i = 0; i < DAYS_AHEAD; i++) ids.push({ id: FIRST_ID + i });
    try {
      await LN.cancel({ notifications: ids });
    } catch (e) {}
  }

  var syncing = Promise.resolve();
  /* Cancel and reschedule from the current progress. Safe to call often;
   * calls queue rather than overlap. */
  function sync(done) {
    if (done) lastDone = done;
    syncing = syncing
      .then(async function () {
        var LN = getPlugin();
        if (!LN) return;
        await cancelAll();
        if (!prefs.on || (await permission()) !== "granted") return;
        await ensureChannel();
        var list = plan(lastDone);
        if (!list.length) return;
        try {
          await LN.schedule({ notifications: list });
        } catch (e) {
          console.warn("Reminders: schedule failed:", e && e.message);
        }
      })
      .catch(function () {});
    return syncing;
  }

  /* Turn reminders on, asking for permission if it has not been asked yet.
   * Resolves to 'on', 'denied' (refused the prompt just shown), 'blocked'
   * (refused earlier, so no prompt can appear: call openSettings) or
   * 'unavailable' (web). */
  async function enable(done) {
    var LN = getPlugin();
    if (!LN) return "unavailable";
    prefs.asked = true;
    var p = await permission();
    var prompted = p === "prompt";
    if (prompted) {
      try {
        var r = await LN.requestPermissions();
        p = r.display === "granted" ? "granted" : "denied";
      } catch (e) {
        p = "denied";
      }
    }
    prefs.on = p === "granted";
    save();
    await sync(done);
    if (prefs.on) return "on";
    return !prompted && p === "denied" ? "blocked" : "denied";
  }

  var settingsPlugin = null;

  /* After a refusal the system stops asking, so its Settings page is the only
   * place left to allow notifications. */
  function openSettings() {
    if (platform() === "ios") {
      /* Capacitor hands non-app navigations to iOS; window.open is blocked after an await. */
      window.location.href = "app-settings:";
      return;
    }
    if (platform() !== "android") return;
    var C = window.Capacitor;
    if (!settingsPlugin && C.registerPlugin) settingsPlugin = C.registerPlugin("NotificationSettings");
    if (!settingsPlugin) return;
    settingsPlugin.open().catch(function (e) {
      console.warn("Reminders: could not open settings:", e && e.message);
    });
  }

  async function disable() {
    prefs.on = false;
    prefs.asked = true;
    save();
    await sync();
  }

  function setHour(h, done) {
    h = Number(h);
    if (!(h >= 0 && h <= 23)) return Promise.resolve();
    prefs.hour = h;
    save();
    return sync(done);
  }

  /* The offer after the first solved daily: shown once per install, only
   * where notifications exist, and only if the system has not already said
   * no (a prompt that cannot appear is a broken button). */
  async function shouldOffer() {
    if (!available() || prefs.asked || prefs.on) return false;
    /* 'granted' too: Android 12 and older have no runtime prompt, so they
       report granted from the start and the offer is the only question. */
    var p = await permission();
    return p === "prompt" || p === "granted";
  }

  function markOffered() {
    prefs.asked = true;
    save();
  }

  /* fn(dayKey) runs when the player taps a reminder. Taps that cold-start the
   * app are held by the plugin until this listener is attached. */
  function onOpen(fn) {
    openHandler = fn;
    var LN = getPlugin();
    if (!LN || !LN.addListener) return;
    try {
      LN.addListener("localNotificationActionPerformed", function (e) {
        var extra = e && e.notification && e.notification.extra;
        if (extra && extra.kind === "daily" && openHandler)
          openHandler(extra.day);
      });
    } catch (e) {}
  }

  window.Reminders = {
    available: available,
    state: function () {
      return { on: prefs.on, asked: prefs.asked, hour: prefs.hour };
    },
    permission: permission,
    enable: enable,
    disable: disable,
    openSettings: openSettings,
    setHour: setHour,
    sync: sync,
    shouldOffer: shouldOffer,
    markOffered: markOffered,
    onOpen: onOpen,
    plan: plan,
  };
})();
