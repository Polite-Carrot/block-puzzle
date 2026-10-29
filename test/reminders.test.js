const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup({ permission = 'prompt', answer = 'granted', platform = 'ios', native = true, stored = null } = {}) {
  const calls = [];
  const storage = new Map(stored ? [['blockpuzzle.reminders.v1', JSON.stringify(stored)]] : []);
  let perm = permission;
  const plugin = {
    async checkPermissions() { return { display: perm }; },
    async requestPermissions() { calls.push(['requestPermissions']); perm = answer; return { display: perm }; },
    async cancel(o) { calls.push(['cancel', o.notifications.map(n => n.id)]); },
    async schedule(o) { calls.push(['schedule', o.notifications]); return {}; },
    async createChannel(o) { calls.push(['createChannel', o.id]); },
    async addListener(name, fn) { calls.push(['addListener', name]); plugin.tap = fn; },
  };
  const context = vm.createContext({
    console: { warn() {} }, Date, Promise, JSON,
    Capacitor: { isNativePlatform: () => native, getPlatform: () => platform, registerPlugin: () => plugin },
    Store: { read: k => (storage.has(k) ? storage.get(k) : null), write: (k, v) => { storage.set(k, v); return true; } },
  });
  context.window = context;
  vm.runInContext(fs.readFileSync('js/daily.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('js/reminders.js', 'utf8'), context);
  return { R: context.Reminders, D: context.Daily, calls, storage, plugin,
    scheduled: () => { const s = calls.filter(c => c[0] === 'schedule').pop(); return s ? s[1] : []; } };
}
const keyOf = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const daysAgo = n => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };

test('nothing is asked or scheduled until the player says yes', async () => {
  const f = setup();
  await f.R.sync({});
  assert.equal(f.calls.some(c => c[0] === 'requestPermissions'), false);
  assert.equal(f.calls.some(c => c[0] === 'schedule'), false);
});

test('yes asks the system once and schedules the next week at the chosen hour', async () => {
  const f = setup();
  assert.equal(await f.R.enable({}), 'on');
  assert.equal(f.calls.filter(c => c[0] === 'requestPermissions').length, 1);
  const list = f.scheduled();
  assert.ok(list.length >= 6 && list.length <= 7);
  for (const n of list) {
    assert.equal(new Date(n.schedule.at).getHours(), 18);
    assert.ok(new Date(n.schedule.at) > new Date());
    assert.equal(n.isExactNotification, false, 'never sends Android players to the exact-alarm settings page');
    assert.equal(n.extra.kind, 'daily');
  }
  assert.equal(new Set(list.map(n => n.id)).size, list.length);
});

test('no reminder today once today is solved', () => {
  const f = setup({ stored: { on: true, asked: true, hour: 23 } });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const morning = new Date(today); morning.setHours(9);
  const unsolved = f.R.plan({}, morning);
  const solved = f.R.plan({ [keyOf(today)]: { stars: 3 } }, morning);
  assert.equal(new Date(unsolved[0].schedule.at).getDate(), today.getDate());
  assert.notEqual(new Date(solved[0].schedule.at).getDate(), today.getDate());
  assert.equal(solved.length, unsolved.length - 1);
});

test('the streak is quoted only on the next reminder, where it is still true', () => {
  const f = setup({ stored: { on: true, asked: true, hour: 23 } });
  const done = {};
  for (let i = 0; i <= 4; i++) done[keyOf(daysAgo(i))] = { stars: 3 };   /* today + 4 before */
  const morning = daysAgo(0); morning.setHours(9);
  const list = f.R.plan(done, morning);
  assert.match(list[0].body, /5-day streak/);
  assert.ok(list.slice(1).every(n => !/streak/.test(n.body)));
});

test('declining at the system prompt leaves reminders off', async () => {
  const f = setup({ answer: 'denied' });
  assert.equal(await f.R.enable({}), 'denied');
  assert.equal(f.R.state().on, false);
  assert.equal(f.calls.some(c => c[0] === 'schedule'), false);
});

test('the offer appears once, and never where the system already said no', async () => {
  const f = setup();
  assert.equal(await f.R.shouldOffer(), true);
  f.R.markOffered();
  assert.equal(await f.R.shouldOffer(), false);
  const g = setup({ permission: 'denied' });
  assert.equal(await g.R.shouldOffer(), false);
  const old = setup({ permission: 'granted', platform: 'android' });
  assert.equal(await old.R.shouldOffer(), true, 'Android 12 and older report granted with no prompt');
});

test('turning it off cancels everything', async () => {
  const f = setup();
  await f.R.enable({});
  await f.R.disable();
  const last = f.calls[f.calls.length - 1];
  assert.equal(last[0], 'cancel');
  assert.equal(f.R.state().on, false);
});

test('changing the hour reschedules at the new time', async () => {
  const f = setup();
  await f.R.enable({});
  await f.R.setHour(8, {});
  assert.ok(f.scheduled().every(n => new Date(n.schedule.at).getHours() === 8));
  assert.equal(JSON.parse(f.storage.get('blockpuzzle.reminders.v1')).hour, 8);
});

test('Android gets its channel before the first schedule', async () => {
  const f = setup({ platform: 'android' });
  await f.R.enable({});
  const names = f.calls.map(c => c[0]);
  assert.ok(names.indexOf('createChannel') < names.indexOf('schedule'));
});

test('tapping a reminder reaches the game; other notifications do not', async () => {
  const f = setup();
  const opened = [];
  f.R.onOpen(day => opened.push(day));
  await f.R.enable({});
  const n = f.scheduled()[0];
  f.plugin.tap({ actionId: 'tap', notification: n });
  f.plugin.tap({ actionId: 'tap', notification: { extra: { kind: 'something-else' } } });
  assert.deepEqual(opened, [n.extra.day]);
});

test('web: nothing to schedule', async () => {
  const f = setup({ native: false, platform: 'web' });
  assert.equal(f.R.available(), false);
  assert.equal(await f.R.enable({}), 'unavailable');
  assert.equal(f.calls.length, 0);
});
