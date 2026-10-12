/* ==========================================================================
   activities.js · 小满券仓「官方活动」卡片区（广告三域分离 · WO-90）
   —— coupon 站 index.html / holidays.html 共用：向后端拉取平台官方活动直链
      （couponActivities，经字段白名单裁剪），渲染为活动卡（rel="sponsored noopener"）。

   数据源：GET {API_BASE}/api/v1/front/coupon/activity/list?limit=<n>&mainUrl=<本站域>
     - 走后端 sourceGuard 来源守卫（coupon.zangeng.com 须已登记为 project）。
     - 仅返回「上架且在活动期内」的活动（后端 isActive 过滤），空池则整块隐藏、不占位。

   解耦（§0.1·4）：本区数据源为 couponActivities，独立于广告位（ads），
     绝不与 ad-slots 混用、不回流为 type=coupon 广告位。

   静默失败：接口异常 / 无数据都不报错、不给占位；仅复用 coupon.css 既有 .cp-card 样式，不新增 CSS。
   ========================================================================== */
(function (global) {
  'use strict';

  var API_BASE = 'https://api.xuyiheng.com';
  var MAIN_URL = 'coupon.zangeng.com';
  var PATH = '/api/v1/front/coupon/activity/list';
  var LIMIT = 8;
  var TIMEOUT_MS = 12000;

  var PLATFORM_NAME = { jd: '京东', taobao: '淘宝', pdd: '拼多多', other: '活动' };

  function safeUrl(u) {
    if (typeof u !== 'string') return '';
    var v = u.trim();
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/\//.test(v)) return 'https:' + v;
    return '';
  }

  function fetchActivities(done) {
    var url = API_BASE + PATH + '?limit=' + encodeURIComponent(LIMIT) + '&mainUrl=' + encodeURIComponent(MAIN_URL);
    var ctrl = global.AbortController ? new global.AbortController() : null;
    var timer = global.setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } } }, TIMEOUT_MS);
    var opts = { cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;
    global.fetch(url, opts)
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (json) {
        global.clearTimeout(timer);
        var d = (json && json.data) || {};
        var arr = Array.isArray(d.list) ? d.list : (Array.isArray(d.data) ? d.data : (Array.isArray(d) ? d : null));
        done(arr && arr.length ? arr : null);
      })
      .catch(function () { global.clearTimeout(timer); done(null); });
  }

  function buildCard(act) {
    var doc = global.document;
    var a = doc.createElement('a');
    a.className = 'cp-card cp-act';
    a.target = '_blank';
    a.setAttribute('rel', 'sponsored noopener');
    a.setAttribute('data-track', 'coupon_activity');
    a.setAttribute('data-track-props', JSON.stringify({
      activity_id: act._id || '', title: act.title || '', platform: act.platform || '',
    }));
    var link = safeUrl(act.url);
    if (link) {
      a.href = link;
    } else {
      a.className += ' is-dead'; // 无直链：置灰不可点（复用券卡死卡样式）
    }
    var cover = safeUrl(act.cover);
    if (cover) {
      var img = doc.createElement('img');
      img.setAttribute('loading', 'lazy');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.alt = act.title || '';
      img.onerror = function () { img.style.display = 'none'; };
      img.src = cover;
      a.appendChild(img);
    }
    var name = doc.createElement('span');
    name.className = 'cp-name';
    name.textContent = act.title || '官方活动';
    a.appendChild(name);
    var price = doc.createElement('div');
    price.className = 'cp-price';
    var tag = doc.createElement('span');
    tag.className = 'cp-off';
    tag.textContent = act.tag || PLATFORM_NAME[act.platform] || '活动';
    price.appendChild(tag);
    a.appendChild(price);
    return a;
  }

  function boot() {
    var doc = global.document;
    if (!doc) return;
    var host = doc.getElementById('cpActs');
    if (!host) return;
    var section = host.closest ? host.closest('section') : null;
    fetchActivities(function (list) {
      if (!list) return; // 空池 / 异常：整块保持隐藏，不占位
      host.innerHTML = '';
      list.slice(0, LIMIT).forEach(function (act) { host.appendChild(buildCard(act)); });
      if (section) section.hidden = false;
    });
  }

  if (doc_stateReady(global)) boot(); else global.addEventListener('DOMContentLoaded', boot);

  function doc_stateReady(g) { return g.document && g.document.readyState !== 'loading'; }
})(typeof window !== 'undefined' ? window : this);
