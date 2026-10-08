/* ==========================================================================
   coupon-page.js · 小满券仓领券中心页交互（coupon.zangeng.com）
   —— 动态请求后端京东优惠券接口，支持：每日精选（随机）、日/周/月榜单、关键词搜索 + 分页加载更多。
   所有请求携带 mainUrl，经后端 sourceGuard 放行（本站域须已登记，见 main-api scripts/register-static-projects.js）。
   静默失败：接口异常 / 空数据都不报错，给出友好空态。
   ========================================================================== */
(function (global) {
  'use strict';

  var API_BASE = 'https://api.xuyiheng.com';
  var MAIN_URL = 'coupon.zangeng.com';
  var PREFIX = '/api/v1/front/coupon/jd';
  var PAGE_SIZE = 20;

  var state = { mode: 'featured', period: 'week', search: '', page: 1, hasMore: false, loading: false };

  var grid, statusEl, moreBtn, tabs, searchForm, searchInput;

  function $(id) { return global.document.getElementById(id); }

  function safeUrl(u) {
    if (typeof u !== 'string') return '';
    var v = u.trim();
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/\//.test(v)) return 'https:' + v;
    return '';
  }

  function buildUrl(path, params) {
    var qs = [];
    params.forEach(function (p) { if (p[1] !== undefined && p[1] !== null && p[1] !== '') qs.push(p[0] + '=' + encodeURIComponent(p[1])); });
    qs.push('mainUrl=' + encodeURIComponent(MAIN_URL));
    return API_BASE + PREFIX + path + '?' + qs.join('&');
  }

  function request(url, done) {
    if (!global.fetch) return done(new Error('fetch unavailable'), null);
    global.fetch(url, { cache: 'no-cache' })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (json) {
        var d = json && json.data;
        done(null, d || {});
      })
      .catch(function (err) { done(err, null); });
  }

  // 归一各接口返回的数组：random→{data:[]}, rank→{list:[]}, paging→{list:[]}
  function pickList(d) {
    if (!d) return [];
    if (Array.isArray(d.data)) return d.data;
    if (Array.isArray(d.list)) return d.list;
    if (Array.isArray(d)) return d;
    return [];
  }

  function el(tag, cls, text) {
    var e = global.document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function buildCard(c) {
    var a = el('a', 'cp-card');
    var link = safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url);
    a.href = link || '#';
    if (link) { a.target = '_blank'; a.setAttribute('rel', 'sponsored noopener'); }
    a.setAttribute('data-track', 'coupon_click');
    a.setAttribute('data-track-props', JSON.stringify({
      coupon_id: c.tao_id || c._id || '', title: c.title || '', mode: state.mode, period: state.mode === 'rank' ? state.period : '',
    }));
    var imgSrc = safeUrl(c.pict_url);
    if (imgSrc) {
      var img = el('img');
      img.alt = c.title || '';
      img.setAttribute('loading', 'lazy');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.onerror = function () { img.parentNode && img.parentNode.removeChild(img); };
      img.src = imgSrc;
      a.appendChild(img);
    }
    a.appendChild(el('span', 'cp-name', c.title || '优惠券'));
    var price = el('div', 'cp-price');
    var off = Number(c.couponDiscount) || 0;
    if (off > 0) price.appendChild(el('span', 'cp-off', '券 ¥' + off));
    var finalPrice = Number(c.price) || 0;
    if (finalPrice > 0) price.appendChild(el('span', 'cp-final', '¥' + finalPrice));
    a.appendChild(price);
    return a;
  }

  function render(list, append) {
    if (!append) grid.innerHTML = '';
    if (!list.length) {
      if (!append) { statusEl.textContent = '暂无优惠券，换个关键词或稍后再试。'; statusEl.hidden = false; }
      return;
    }
    statusEl.hidden = true;
    list.forEach(function (c) { grid.appendChild(buildCard(c)); });
  }

  function setLoading(on) {
    state.loading = on;
    moreBtn.disabled = on;
    if (on) { statusEl.hidden = false; statusEl.textContent = '加载中…'; }
  }

  // 精选：随机十条
  function loadFeatured() {
    state.mode = 'featured';
    moreBtn.hidden = true;
    setLoading(true);
    request(buildUrl('/random', [ [ 'limit', 10 ] ]), function (err, d) {
      setLoading(false);
      if (err) { statusEl.textContent = '加载失败，请稍后重试。'; return; }
      render(pickList(d), false);
    });
  }

  // 榜单：日/周/月
  function loadRank(period) {
    state.mode = 'rank';
    state.period = period;
    moreBtn.hidden = true;
    setLoading(true);
    request(buildUrl('/rank', [ [ 'period', period ], [ 'limit', 20 ] ]), function (err, d) {
      setLoading(false);
      if (err) { statusEl.textContent = '加载失败，请稍后重试。'; return; }
      render(pickList(d), false);
    });
  }

  // 搜索 / 分页
  function loadSearch(reset) {
    state.mode = 'search';
    if (reset) { state.page = 1; grid.innerHTML = ''; }
    setLoading(true);
    request(buildUrl('/paging', [ [ 'search', state.search ], [ 'page', state.page ], [ 'pageSize', PAGE_SIZE ] ]), function (err, d) {
      setLoading(false);
      if (err) { statusEl.textContent = '加载失败，请稍后重试。'; return; }
      var list = pickList(d);
      render(list, !reset);
      var count = Number(d && d.count) || 0;
      state.hasMore = state.page * PAGE_SIZE < count;
      moreBtn.hidden = !(state.hasMore && list.length);
    });
  }

  function setActiveTab(period) {
    Array.prototype.forEach.call(tabs.children, function (t) {
      t.classList.toggle('is-active', t.getAttribute('data-period') === period);
    });
  }

  function init() {
    grid = $('cpGrid'); statusEl = $('cpState'); moreBtn = $('cpMore');
    tabs = $('cpTabs'); searchForm = $('cpSearchForm'); searchInput = $('cpSearchInput');
    if (!grid || !statusEl) return;

    Array.prototype.forEach.call(tabs.children, function (t) {
      t.addEventListener('click', function () {
        var period = t.getAttribute('data-period');
        setActiveTab(period);
        loadRank(period);
      });
    });

    searchForm.addEventListener('submit', function (e) {
      e.preventDefault();
      state.search = (searchInput.value || '').trim();
      setActiveTab('');
      if (!state.search) { loadFeatured(); return; }
      loadSearch(true);
    });

    moreBtn.addEventListener('click', function () {
      if (state.loading || !state.hasMore) return;
      state.page += 1;
      loadSearch(false);
    });

    loadFeatured();
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
