/* ==========================================================================
   drops-page.js · 降价热榜页交互（W2/W3 · /drops.html）
   —— 三级数据源（全部 fail-soft）：
     0) 首选中台 topDrops 接口（W3：近 48h 快照两点对比，真实降价/加码，自带角标）；
     1) 预渲染兜底：券卡由 build.js 按力度降序写死，运行时批量 priceBatch 补「↓已降」角标；
     2) 预渲染网格为空（构建期上游不可达）时，用 /data/coupon-snapshot.json 的 drops
        （再退化为 browse/featured）兜底渲染，仍是力度降序。
   —— 页面曝光打 drops_view 事件；接口/快照任一异常都保持现状，不报错不闪烁。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var API_BASE = 'https://api.xuyiheng.com';
  var MAIN_URL = 'coupon.zangeng.com';
  var PREFIX = '/api/v1/front/coupon/jd';

  function num(v) { return (Math.round(Number(v) * 100) / 100) || 0; }
  function safeUrl(u) {
    if (typeof u !== 'string') return '';
    var v = u.trim();
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/\//.test(v)) return 'https:' + v;
    return '';
  }

  /* --------------------- 快照兜底渲染（预渲染为空时） --------------------- */
  function cardHtml(c, badgeTxt) {
    var link = safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url) || '';
    var off = Number(c.couponDiscount) || 0, quota = Number(c.couponQuota) || 0, price = Number(c.price) || 0;
    var img = safeUrl(c.pict_url);
    var h = '<a class="cp-card" href="' + (link || '#') + '" rel="sponsored noopener" target="_blank" data-track="coupon_click" data-case="coupon:' + (c.tao_id || '') + '">';
    if (img) h += '<img src="' + img + '" alt="' + (c.title || '优惠券') + '" width="300" height="300" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
    h += '<span class="cp-name">' + (c.title || '优惠券') + '</span><div class="cp-price">';
    if (off > 0) h += '<span class="cp-off">' + (quota > 0 ? ('满' + quota + '减' + off) : ('券 ¥' + off)) + '</span>';
    if (price > 0) h += '<span class="cp-final">¥' + price + '</span>';
    if (badgeTxt) h += '<span class="dp-drop">' + badgeTxt + '</span>';
    h += '</div></a>';
    return h;
  }

  function renderFallback(list) {
    var grid = doc.getElementById('dropsGrid');
    var empty = doc.getElementById('dropsEmpty');
    if (!grid || grid.children.length) return false;
    var top = list.filter(function (c) { return c && (c.clickURL || c.couponUrl || c.item_url) && (Number(c.couponDiscount) || 0) > 0; })
      .sort(function (a, b) { return (Number(b.couponDiscount) || 0) - (Number(a.couponDiscount) || 0); })
      .slice(0, 24);
    if (!top.length) return false;
    grid.innerHTML = top.map(function (c) { return cardHtml(c); }).join('');
    if (empty) empty.hidden = true;
    // 运行时卡手动补星标/分享/提醒（预渲染卡由 store.js boot 自动增强）
    if (global.CouponStore) {
      Array.prototype.forEach.call(grid.querySelectorAll('.cp-card'), function (a) {
        var it = global.CouponStore.itemFromCard(a);
        if (it) global.CouponStore.attachStar(a, it);
      });
    }
    return true;
  }

  function loadSnapshot(cb) {
    fetch('/data/coupon-snapshot.json', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { cb(j || null); })
      .catch(function () { cb(null); });
  }

  /* ---------------------- 「已降」角标：两快照力度差 ---------------------- */
  function markDrops() {
    var grid = doc.getElementById('dropsGrid');
    if (!grid) return;
    var cards = grid.querySelectorAll('a.cp-card[data-case]');
    if (!cards.length) return;
    var byId = {};
    var ids = [];
    Array.prototype.forEach.call(cards, function (a) {
      var id = (a.getAttribute('data-case') || '').replace(/^coupon:/, '');
      if (id && !byId[id]) { byId[id] = a; ids.push(id); }
    });
    if (!ids.length) return;
    var url = API_BASE + PREFIX + '/priceBatch?ids=' + encodeURIComponent(ids.slice(0, 60).join(',')) +
      '&limit=30&mainUrl=' + encodeURIComponent(MAIN_URL);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 12000);
    fetch(url, { signal: ctrl.signal })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        clearTimeout(timer);
        var map = (j && j.data && j.data.map) || {};
        var n = 0;
        ids.forEach(function (id) {
          var series = map[id];
          if (!Array.isArray(series) || series.length < 2) return;
          var first = series[0], last = series[series.length - 1];
          var priceDown = num(first.price) > num(last.price) && num(last.price) > 0;
          var offUp = num(last.couponDiscount) > num(first.couponDiscount);
          if (!priceDown && !offUp) return;
          var card = byId[id];
          var priceEl = card.querySelector('.cp-price');
          if (!priceEl || priceEl.querySelector('.dp-drop')) return;
          var badge = doc.createElement('span');
          badge.className = 'dp-drop';
          badge.textContent = priceDown ? ('↓已降 ¥' + num(first.price - last.price)) : ('↑券加码 ¥' + num(last.couponDiscount - first.couponDiscount));
          priceEl.appendChild(badge);
          n++;
        });
        if (global.Tracker) global.Tracker.track('drops_view', { cards: ids.length, marked: n });
      })
      .catch(function () { clearTimeout(timer); });
  }

  /* ---------------- W3 正式版：topDrops 接口（近 48h 快照两点对比，自带角标） ---------------- */
  function renderTopDrops(list) {
    var grid = doc.getElementById('dropsGrid');
    var empty = doc.getElementById('dropsEmpty');
    if (!grid) return false;
    grid.innerHTML = list.map(function (c) {
      var badge = '';
      if (num(c.dropPrice) > 0) badge = '↓已降 ¥' + num(c.dropPrice);
      else if (num(c.dropOff) > 0) badge = '↑券加码 ¥' + num(c.dropOff);
      return cardHtml(c, badge);
    }).join('');
    if (empty) empty.hidden = true;
    if (global.CouponStore) {
      Array.prototype.forEach.call(grid.querySelectorAll('a.cp-card'), function (a) {
        var it = global.CouponStore.itemFromCard(a);
        if (it) global.CouponStore.attachStar(a, it);
      });
    }
    if (global.Tracker) global.Tracker.track('drops_view', { live: 1, cards: list.length });
    var st = doc.getElementById('dropsState');
    if (st) { st.hidden = false; st.textContent = '已按近 48 小时真实降价/加码实时更新（共 ' + list.length + ' 条）'; }
    return true;
  }

  function tryTopDrops(cb) {
    var url = API_BASE + PREFIX + '/topDrops?limit=24&mainUrl=' + encodeURIComponent(MAIN_URL);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 12000);
    fetch(url, { signal: ctrl.signal })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        clearTimeout(timer);
        var list = (j && j.data && Array.isArray(j.data.list)) ? j.data.list : [];
        cb(list.length ? list : null);
      })
      .catch(function () { clearTimeout(timer); cb(null); });
  }

  /* -------------------------------- boot -------------------------------- */
  function boot() {
    markDrops();
    var grid = doc.getElementById('dropsGrid');
    // 首选正式版：接口真实降价覆盖预渲染/快照兜底
    tryTopDrops(function (live) {
      if (live && renderTopDrops(live)) return;
      if (grid && !grid.children.length) {
        loadSnapshot(function (snap) {
          if (!snap) return;
          var list = snap.drops && snap.drops.length ? snap.drops
            : (snap.browse && snap.browse.length ? snap.browse : (snap.featured || []));
          renderFallback(list);
          markDrops();
        });
      } else {
        // 预渲染非空：上报曝光（含标记结果由 markDrops 内部打点）
        if (global.Tracker) { try { global.Tracker.track('drops_view', { prerender: 1 }); } catch (e) {} }
      }
    });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
