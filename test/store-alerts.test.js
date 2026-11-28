'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const Q = require('../assets/js/coupon-quality');

function loadStore(options = {}) {
  const data = new Map();
  let writes = 0;
  let fetches = 0;
  const storage = {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) {
      if (options.failWrite) throw new Error('quota');
      writes++;
      data.set(key, value);
    },
  };
  const sandbox = {
    console, Blob, Date, JSON, Number, isFinite, Object, Array, String, Math,
    localStorage: storage,
    document: { readyState: 'loading', addEventListener() {} },
    navigator: { userAgent: '' },
    location: { origin: 'https://coupon.zangeng.com', pathname: '/my-alerts.html', search: '' },
    fetch() { fetches++; return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) }); },
    Tracker: { visitorId: () => 'device-test' },
    setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/store.js'), 'utf8'), sandbox);
  return { store: sandbox.CouponStore, data, writes: () => writes, fetches: () => fetches };
}

function alert(id, extra = {}) {
  return Object.assign({
    id, _id: '507f1f77bcf86cd799439011', did: '507f1f77bcf86cd799439011', t: '测试券', img: 'https://img.example/a.jpg',
    url: 'https://item.example/' + id, couponUrl: 'https://coupon.example/' + id, price: 99, quota: 100, couponDiscount: 10, off: 10,
    baseline: { price: 99, quota: 100, couponDiscount: 10 }, ts: Date.now(),
  }, extra);
}

function backup(items) {
  return JSON.stringify({ v: 1, type: 'price-alerts', site: 'coupon.zangeng.com', alerts: items });
}

test('预览只读且不调用订阅接口，导出保持单一存储入口', () => {
  const env = loadStore();
  env.store.toggleAlert(alert('local'));
  const fetches = env.fetches();
  const writes = env.writes();
  const preview = env.store.previewAlerts(backup([ alert('new') ]));
  assert.equal(preview.ok, true);
  assert.equal(preview.valid, 1);
  assert.equal(env.writes(), writes);
  assert.equal(env.fetches(), fetches);
  const exported = JSON.parse(env.store.exportAlerts());
  assert.equal(exported.type, 'price-alerts');
  assert.equal(exported.alerts[0].id, 'local');
});

test('合并按 id 去重并保留现有订阅，不触发网络请求', () => {
  const env = loadStore();
  env.store.toggleAlert(alert('same'));
  const fetches = env.fetches();
  const result = env.store.importAlerts(backup([ alert('same'), alert('new') ]), 'merge');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, added: 1, total: 2, mode: 'merge' });
  assert.deepEqual(Array.from(env.store.alerts(), item => item.id), [ 'same', 'new' ]);
  assert.equal(env.fetches(), fetches);
});

test('替换以备份为准并执行 50 条上限', () => {
  const env = loadStore();
  env.store.toggleAlert(alert('old'));
  const items = Array.from({ length: 55 }, (_, i) => alert('new-' + i));
  const preview = env.store.previewAlerts(backup(items));
  assert.equal(preview.valid, 55);
  assert.equal(preview.overflow, 5);
  const result = env.store.importAlerts(backup(items), 'replace');
  assert.equal(result.total, 50);
  assert.equal(env.store.alerts().some(item => item.id === 'old'), false);
});

test('分类统计损坏、文件内重复、明确过期和超量记录', () => {
  const env = loadStore();
  const old = Date.now() - 181 * 24 * 3600 * 1000;
  const preview = env.store.previewAlerts(backup([
    alert('ok'), alert('ok'), alert('bad', { price: -1 }), alert('expired', { ts: old }),
    alert('ended', { couponEndTime: Date.now() - 1000 }),
  ]));
  assert.equal(preview.valid, 1);
  assert.equal(preview.duplicates, 1);
  assert.equal(preview.invalid, 1);
  assert.equal(preview.expired, 2);
});

test('拒绝非法信封、超大文件、未知模式和写入失败', () => {
  const env = loadStore();
  assert.equal(env.store.previewAlerts('{').ok, false);
  assert.equal(env.store.previewAlerts(JSON.stringify({ v: 2, alerts: [] })).ok, false);
  assert.match(env.store.previewAlerts(backup([ alert('x', { t: '券'.repeat(200000) }) ])).msg, /512KB/);
  assert.equal(env.store.importAlerts(backup([ alert('x') ]), 'other').ok, false);
  const blocked = loadStore({ failWrite: true });
  assert.equal(blocked.store.importAlerts(backup([ alert('x') ]), 'merge').ok, false);
  assert.equal(blocked.store.alerts().length, 0);
});

test('对客快照投影移除脏记录且不修改原始快照', () => {
  const raw = {
    updatedAt: new Date().toISOString(),
    featured: [ alert('ok'), alert('ok'), alert('no-coupon', { off: 0, couponDiscount: 0, couponUrl: '' }), alert('expired', { couponEndTime: Date.now() - 1000 }) ],
    browse: [], drops: [], rank: { day: [], week: [], month: [] }, category: { phone: [ alert('category') ] },
    detailIds: [ '507f1f77bcf86cd799439011', 'bad' ],
  };
  const before = JSON.stringify(raw);
  const projected = Q.projectCustomerSnapshot(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(projected.featured.length, 1);
  assert.equal(projected.category.phone.length, 1);
  assert.deepEqual(projected.detailIds, [ '507f1f77bcf86cd799439011' ]);
  assert.equal(projected.quality.removed, 3);
});
