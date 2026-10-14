/* ==========================================================================
   store.js · 小满券仓本地数据层（收藏 / 最近看过 / 搜索历史）
   —— 纯 localStorage、零依赖、静默失败（无痕模式 / 配额满时不报错，功能自动降级）。
   · 券卡星标：coupon-page.js / list-page.js 生成卡片时调 CouponStore.attachStar；
     预渲染静态券卡由本脚本启动时补增强（包一层 .cp-cell + 收藏按钮，禁 JS 不受影响）。
   · 最近看过：事件委托捕获 .cp-card 点击，从 DOM 反解券快照（上限 24 条）。
   · 收藏上限 100、搜索历史上限 10；数据结构为紧凑快照 {id,t,img,url,price,quota,off,at}。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var K_FAV = 'coupon_favs';
  var K_RECENT = 'coupon_recent';
  var K_SEARCH = 'coupon_searches';
  var K_ALERT = 'coupon_alerts';
  var API_BASE = 'https://api.xuyiheng.com';
  var FAV_MAX = 100;
  var RECENT_MAX = 24;
  var SEARCH_MAX = 10;

  function lsGet(key) {
    try {
      var raw = global.localStorage.getItem(key);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function lsSet(key, arr) {
    try { global.localStorage.setItem(key, JSON.stringify(arr)); } catch (e) { /* 无痕/满配额：静默降级 */ }
  }

  /* ------------------------------- 快照工具 ------------------------------- */
  function numFrom(text, re) {
    var m = String(text || '').match(re);
    return m ? Number(m[1]) : 0;
  }

  // 从券卡 DOM 反解紧凑快照（预渲染卡与运行时卡同构，均带 cp-name/cp-off/cp-final）
  function itemFromCard(a) {
    var cid = (a.getAttribute('data-case') || '').replace(/^coupon:/, '');
    var url = a.href || '';
    var id = cid || url;
    if (!id || id === '#') return null;
    var nameEl = a.querySelector('.cp-name');
    var offEl = a.querySelector('.cp-off');
    var finEl = a.querySelector('.cp-final');
    var imgEl = a.querySelector('img');
    var quota = 0, off = 0;
    if (offEl) {
      quota = numFrom(offEl.textContent, /满(\d+(?:\.\d+)?)减/);
      off = numFrom(offEl.textContent, quota > 0 ? /减(\d+(?:\.\d+)?)/ : /(\d+(?:\.\d+)?)/);
    }
    return {
      id: String(id),
      t: nameEl ? (nameEl.textContent || '').trim() : '',
      img: imgEl ? (imgEl.getAttribute('src') || '') : '',
      url: (/^https?:\/\//i.test(url) ? url : ''),
      price: finEl ? numFrom(finEl.textContent, /(\d+(?:\.\d+)?)/) : 0,
      quota: quota,
      off: off,
    };
  }

  /* -------------------------------- 收藏 -------------------------------- */
  function favs() { return lsGet(K_FAV); }

  function isFav(id) {
    if (!id) return false;
    return favs().some(function (f) { return f.id === String(id); });
  }

  // 返回切换后的收藏态（true=已收藏）
  function toggleFav(item) {
    if (!item || !item.id) return false;
    var id = String(item.id);
    var arr = favs();
    var next = arr.filter(function (f) { return f.id !== id; });
    var on = next.length === arr.length; // 原列表没删掉任何东西 → 新收藏
    if (on) next.unshift({ id: id, t: item.t || '', img: item.img || '', url: item.url || '', price: item.price || 0, quota: item.quota || 0, off: item.off || 0, at: Date.now() });
    lsSet(K_FAV, next.slice(0, FAV_MAX));
    return on;
  }

  function removeFav(id) {
    lsSet(K_FAV, favs().filter(function (f) { return f.id !== String(id); }));
  }

  function clearFavs() { lsSet(K_FAV, []); }

  // 导出收藏为 JSON 文本（本地备份 / 跨设备迁移）
  function exportFavs() {
    return JSON.stringify({ v: 1, site: 'coupon.zangeng.com', exportedAt: new Date().toISOString(), favs: favs() });
  }
  // 从 JSON 文本导入收藏：按 id 合并去重、保留已有；返回 {ok:true,added,total} 或 {ok:false,msg}
  function importFavs(text) {
    var obj;
    try { obj = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { ok: false, msg: '不是合法的 JSON 文件' }; }
    var arr = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.favs) ? obj.favs : null);
    if (!arr) return { ok: false, msg: '文件中没有收藏数据' };
    var cur = favs();
    var seen = {};
    cur.forEach(function (f) { if (f && f.id != null) seen[String(f.id)] = 1; });
    var added = 0;
    arr.forEach(function (f) {
      if (!f || f.id == null) return;
      var id = String(f.id);
      if (seen[id]) return;
      cur.push({ id: id, t: f.t || '', img: f.img || '', url: f.url || '', price: Number(f.price) || 0, quota: Number(f.quota) || 0, off: Number(f.off) || 0, at: Number(f.at) || Date.now() });
      seen[id] = 1;
      added++;
    });
    lsSet(K_FAV, cur.slice(0, FAV_MAX));
    return { ok: true, added: added, total: Math.min(cur.length, FAV_MAX) };
  }

  /* ------------------------------ 最近看过 ------------------------------ */
  function recent() { return lsGet(K_RECENT); }

  function pushRecent(item) {
    if (!item || !item.id) return;
    var id = String(item.id);
    var arr = recent().filter(function (f) { return f.id !== id; });
    item = { id: id, t: item.t || '', img: item.img || '', url: item.url || '', price: item.price || 0, quota: item.quota || 0, off: item.off || 0, at: Date.now() };
    arr.unshift(item);
    lsSet(K_RECENT, arr.slice(0, RECENT_MAX));
  }

  function removeRecent(id) {
    lsSet(K_RECENT, recent().filter(function (f) { return f.id !== String(id); }));
  }

  function clearRecent() { lsSet(K_RECENT, []); }

  /* ------------------------------ 搜索历史 ------------------------------ */
  function searches() { return lsGet(K_SEARCH); }

  function pushSearch(kw) {
    kw = String(kw || '').trim();
    if (!kw) return;
    var arr = searches().filter(function (s) { return s !== kw; });
    arr.unshift(kw);
    lsSet(K_SEARCH, arr.slice(0, SEARCH_MAX));
  }

  function clearSearches() { lsSet(K_SEARCH, []); }

  /* ---------------------- 猜你喜欢（M1）本地信号 ---------------------- */
  // 用户信号词：最近看过标题 + 搜索历史，供 coupon-page.js 做子串匹配重排
  function recommendTerms() {
    var terms = [];
    recent().forEach(function (r) { if (r && r.t) terms.push(r.t); });
    searches().forEach(function (s) { if (s) terms.push(s); });
    return terms.slice(0, 16);
  }
  // 已曝光/已收藏的券 id 集合，猜你喜欢去重用
  function seenIds() {
    var s = {};
    favs().forEach(function (f) { if (f && f.id != null) s[String(f.id)] = 1; });
    recent().forEach(function (f) { if (f && f.id != null) s[String(f.id)] = 1; });
    return s;
  }

  /* ---------------------- 降价提醒（M2） ---------------------- */
  function alerts() { return lsGet(K_ALERT, []); }
  function isAlert(id) { return alerts().some(function (x) { return x.id === String(id); }); }
  // 切换订阅：本地 localStorage 为主，后端上报为最佳努力（失败忽略）
  function toggleAlert(item) {
    var list = alerts();
    var id = String(item.id);
    if (!id) return false;
    var idx = -1;
    list.forEach(function (x, i) { if (x.id === id) idx = i; });
    var on;
    if (idx >= 0) { list.splice(idx, 1); on = false; }
    else {
      list.unshift({
        id: id, t: item.t || '', img: item.img || '', url: item.url || '',
        price: Number(item.price) || 0, quota: Number(item.quota) || 0, off: Number(item.off) || 0,
        baseline: { price: Number(item.price) || 0, quota: Number(item.quota) || 0, couponDiscount: Number(item.off) || 0 },
        ts: Date.now(),
      });
      on = true;
    }
    lsSet(K_ALERT, list.slice(0, 50));
    syncAlert(on ? 'subscribe' : 'unsubscribe', item);
    return on;
  }
  function syncAlert(action, item) {
    var dev = global.Tracker && global.Tracker.visitorId ? global.Tracker.visitorId() : '';
    if (!dev) return;
    var url = (action === 'subscribe' ? '/api/v1/front/coupon/alert/subscribe' : '/api/v1/front/coupon/alert/unsubscribe');
    try {
      global.fetch(API_BASE + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: dev, tao_id: String(item.id), platform: (item.platform || 'jd'),
          title: item.t || '',
          baseline: { price: Number(item.price) || 0, quota: Number(item.quota) || 0, couponDiscount: Number(item.off) || 0 },
        }),
      }).catch(function () { /* 忽略 */ });
    } catch (e) { /* 忽略 */ }
  }
  // 把「降价提醒」按钮挂到券卡价格行（绝对定位会拥挤，改为价格行内联胶囊）
  function attachAlert(cardEl, item) {
    if (!cardEl || !item || !item.id) return;
    var price = cardEl.querySelector ? cardEl.querySelector('.cp-price') : null;
    if (!price) return;
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'cp-alert';
    var on = isAlert(item.id);
    btn.textContent = on ? '已提醒' : '降价提醒';
    if (on) btn.classList.add('is-on');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var nowOn = toggleAlert(item);
      btn.textContent = nowOn ? '已提醒' : '降价提醒';
      btn.classList.toggle('is-on', nowOn);
      btn.setAttribute('aria-pressed', nowOn ? 'true' : 'false');
      if (global.Conv) global.Conv.track('alert_toggle', { coupon_id: String(item.id), on: nowOn ? 1 : 0 });
    });
    price.appendChild(btn);
  }

  /* ------------------------------ 券卡星标 ------------------------------ */
  function syncStar(btn, on) {
    btn.textContent = on ? '★' : '☆';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? '取消收藏' : '收藏该券');
    btn.setAttribute('title', on ? '取消收藏' : '收藏该券');
    btn.classList.toggle('is-on', on);
  }

  // 给券卡（<a class="cp-card">）包一层 .cp-cell 并附加收藏星标
  function attachStar(cardEl, item) {
    if (!cardEl || cardEl.parentElement && cardEl.parentElement.classList.contains('cp-cell')) return;
    if (!item || !item.id) return;
    var cell = doc.createElement('div');
    cell.className = 'cp-cell';
    cardEl.parentNode.insertBefore(cell, cardEl);
    cell.appendChild(cardEl);
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'cp-star';
    btn.setAttribute('data-track', 'fav_toggle');
    syncStar(btn, isFav(item.id));
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      syncStar(btn, toggleFav(item));
    });
    cell.appendChild(btn);
    // 分享按钮（M4）：与星标并列，缺 CouponShare 时静默跳过
    if (global.CouponShare && global.CouponShare.attach) {
      try { global.CouponShare.attach(cell, item); } catch (e) { /* 忽略 */ }
    }
    // 降价提醒按钮（M2）：挂到券卡价格行内联
    if (global.CouponStore && global.CouponStore.attachAlert) {
      try { global.CouponStore.attachAlert(cell, item); } catch (e) { /* 忽略 */ }
    }
  }

  // 增强页面里已存在的静态券卡（构建期预渲染产物），运行时卡由各自脚本直接 attachStar
  function enhance(root) {
    if (!root) return;
    var cards = root.querySelectorAll('.cp-card');
    Array.prototype.forEach.call(cards, function (a) {
      if (a.closest && a.closest('.cp-cell')) return;
      attachStar(a, itemFromCard(a));
    });
  }

  function boot() {
    Array.prototype.forEach.call(doc.querySelectorAll('.cp-grid'), enhance);
    // 点击券卡 = 视为「看过」，写最近看过快照（星标按钮在 a 外，不会误触）
    doc.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('.cp-card') : null;
      if (!a) return;
      if (a.getAttribute('href') === '#' || !a.getAttribute('href')) return;
      pushRecent(itemFromCard(a));
    });
  }

  global.CouponStore = {
    favs: favs, isFav: isFav, toggleFav: toggleFav, removeFav: removeFav, clearFavs: clearFavs,
    exportFavs: exportFavs, importFavs: importFavs,
    recent: recent, pushRecent: pushRecent, removeRecent: removeRecent, clearRecent: clearRecent,
    searches: searches, pushSearch: pushSearch, clearSearches: clearSearches,
    recommendTerms: recommendTerms, seenIds: seenIds,
    alerts: alerts, isAlert: isAlert, toggleAlert: toggleAlert, attachAlert: attachAlert,
    itemFromCard: itemFromCard, attachStar: attachStar, enhance: enhance,
  };

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
