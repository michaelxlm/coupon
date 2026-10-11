/* ==========================================================================
   coupon-page.js · 小满券仓领券中心页交互（coupon.zangeng.com）
   —— 动态请求后端京东优惠券接口，支持：每日精选（手选池）、日/周/月榜单、关键词搜索 + 分页加载更多。
   所有请求携带 mainUrl，经后端 sourceGuard 放行（本站域须已登记，见 main-api scripts/register-static-projects.js）。
   静默失败：接口异常 / 空数据都不报错，给出友好空态（并提供「重试」）。

   健壮性（C3）：AbortController 超时 + 自增 token 丢弃过期响应（防切 tab/搜索乱序覆盖）+ 同参短时内存缓存。
   曝光埋点（C2）：券卡带 data-case，由 conversion.js 观察视口产出「曝光→点击」归因。
   防 CLS（C4）：卡片图带 width/height，配合 coupon.css 的 aspect-ratio 占位。
   排序透出（C8）：对已加载结果按 券面额 / 到手价 做客户端排序（低成本，不改后端分页语义）。
   本地功能：券卡收藏星标 + 骨架屏加载态；?s=关键词 直达搜索；搜索历史由 store.js 落 localStorage。
   ========================================================================== */
(function (global) {
  'use strict';

  var API_BASE = 'https://api.xuyiheng.com';
  var MAIN_URL = 'coupon.zangeng.com';
  var PREFIX = '/api/v1/front/coupon/jd';
  var PAGE_SIZE = 20;
  var TIMEOUT_MS = 12000;   // 单请求超时，超时中断并给出可重试错误态
  var CACHE_TTL = 30000;    // 同参结果短时内存缓存（切 tab 回来不重复打后端）

  var state = { mode: 'featured', period: 'week', search: '', page: 1, hasMore: false, loading: false, sort: '', list: [] };

  var grid, statusEl, moreBtn, tabs, searchForm, searchInput, sortSelect;
  var loadActions = {}; // name -> function，供错误态「重试」复用最近一次加载动作

  // 短时内存缓存：url -> { t, data }
  var memCache = {};
  // 竞态令牌：每次触发一次「视图级」加载就自增，回调仅当令牌仍为最新时才落 DOM
  var viewToken = 0;

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

  function cacheGet(url) {
    var c = memCache[url];
    if (c && (Date.now() - c.t) < CACHE_TTL) return c.data;
    return null;
  }

  /**
   * 带超时与内存缓存的请求（C3）
   * @param {string} url
   * @param {Function} done - (err, data)
   * @param {Object} [o] - { cache:boolean } cache=true 时命中/写入短时内存缓存
   */
  function request(url, done, o) {
    o = o || {};
    if (o.cache) {
      var hit = cacheGet(url);
      if (hit) { done(null, hit); return; }
    }
    var ctrl = global.AbortController ? new global.AbortController() : null;
    var timer = global.setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } } }, TIMEOUT_MS);
    var opts = { cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;
    global.fetch(url, opts)
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (json) {
        global.clearTimeout(timer);
        var d = (json && json.data) || {};
        if (o.cache) memCache[url] = { t: Date.now(), data: d };
        done(null, d);
      })
      .catch(function (err) { global.clearTimeout(timer); done(err, null); });
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

  // 客户端排序（C8）：不改动后端分页/榜单语义，仅对已加载集合重排
  function sortList(list) {
    if (!state.sort) return list;
    var arr = list.slice();
    if (state.sort === 'discount') arr.sort(function (a, b) { return (Number(b.couponDiscount) || 0) - (Number(a.couponDiscount) || 0); });
    else if (state.sort === 'priceAsc') arr.sort(function (a, b) { return (Number(a.price) || 0) - (Number(b.price) || 0); });
    else if (state.sort === 'priceDesc') arr.sort(function (a, b) { return (Number(b.price) || 0) - (Number(a.price) || 0); });
    return arr;
  }

  function buildCard(c) {
    var a = el('a', 'cp-card');
    var link = safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url);
    a.href = link || '#';
    if (link) { a.target = '_blank'; a.setAttribute('rel', 'sponsored noopener'); }
    else { a.classList.add('is-dead'); a.setAttribute('aria-disabled', 'true'); }
    // 曝光埋点（C2）：data-case 供 conversion.js 视口观察；点击埋点保持 data-track
    var cid = String(c.tao_id || c._id || '');
    if (cid) a.setAttribute('data-case', 'coupon:' + cid);
    a.setAttribute('data-track', 'coupon_click');
    a.setAttribute('data-track-props', JSON.stringify({
      coupon_id: cid, title: c.title || '', mode: state.mode, period: state.mode === 'rank' ? state.period : '',
    }));
    var imgSrc = safeUrl(c.pict_url);
    if (imgSrc) {
      var img = el('img');
      img.alt = c.title || '';
      // 防 CLS（C4）：显式固有尺寸，与 coupon.css 的 aspect-ratio 占位配合
      img.width = 300;
      img.height = 300;
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.onerror = function () { img.parentNode && img.parentNode.removeChild(img); };
      img.src = imgSrc;
      a.appendChild(img);
    }
    a.appendChild(el('span', 'cp-name', c.title || '优惠券'));
    var price = el('div', 'cp-price');
    var off = Number(c.couponDiscount) || 0;
    var quota = Number(c.couponQuota) || 0;
    if (off > 0) price.appendChild(el('span', 'cp-off', quota > 0 ? ('满' + quota + '减' + off) : ('券 ¥' + off)));
    var finalPrice = Number(c.price) || 0;
    if (finalPrice > 0) price.appendChild(el('span', 'cp-final', '¥' + finalPrice));
    a.appendChild(price);
    // 时效标签（今日新增）：createTime 在 24h 内
    var ct = Number(c.createTime) || 0;
    if (ct && (Date.now() - ct) < 24 * 60 * 60 * 1000) a.appendChild(el('span', 'cp-fresh', '今日新增'));
    return a;
  }

  function render(list, append) {
    if (!append) grid.innerHTML = '';
    if (!list.length) {
      if (!append) { showStatus('暂无优惠券，换个关键词或稍后再试。'); }
      return;
    }
    hideStatus();
    list.forEach(function (c) { var card = buildCard(c); grid.appendChild(card); attachStar(card, c); });
    // 动态新增的券卡带 data-case，通知归因层补观察（否则首屏 boot 时的 observer 覆盖不到）
    if (global.Conv && global.Conv.reobserve) global.Conv.reobserve();
  }

  // 状态区（aria-live 已在 index.html 上声明），带错误态重试按钮
  function showStatus(text, retryFn) {
    statusEl.textContent = text;
    statusEl.hidden = false;
    statusEl.setAttribute('aria-busy', 'false');
    // 清除上一次残留的重试按钮
    var old = $('cpRetry');
    if (old) old.parentNode && old.parentNode.removeChild(old);
    if (retryFn) {
      var btn = el('button', 'btn btn-ghost cp-retry', '重试');
      btn.id = 'cpRetry';
      btn.type = 'button';
      btn.addEventListener('click', function () { retryFn(); });
      statusEl.appendChild(document.createElement('br'));
      statusEl.appendChild(btn);
    }
  }

  function hideStatus() {
    statusEl.hidden = true;
    statusEl.setAttribute('aria-busy', 'false');
    var old = $('cpRetry');
    if (old) old.parentNode && old.parentNode.removeChild(old);
  }

  // 收藏星标（store.js 提供）：包 .cp-cell + 按钮，运行时卡与预渲染卡同一套交互
  function attachStar(cardEl, c) {
    if (!global.CouponStore) return;
    var link = safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url);
    var cid = String(c.tao_id || c._id || '') || link;
    if (!cid) return;
    global.CouponStore.attachStar(cardEl, {
      id: cid, t: c.title || '', img: safeUrl(c.pict_url), url: link || '',
      price: Number(c.price) || 0, quota: Number(c.couponQuota) || 0, off: Number(c.couponDiscount) || 0,
    });
  }

  // 骨架屏（性能小件）：重置加载时先占位，避免空白跳变（防 CLS 延伸）
  function showSkeleton(n) {
    grid.innerHTML = '';
    for (var i = 0; i < n; i++) {
      var s = el('div', 'cp-skeleton');
      s.setAttribute('aria-hidden', 'true');
      s.appendChild(el('div', 'cp-sk-img'));
      s.appendChild(el('div', 'cp-sk-line'));
      s.appendChild(el('div', 'cp-sk-line is-short'));
      grid.appendChild(s);
    }
  }

  function setLoading(on, quiet) {
    state.loading = on;
    moreBtn.disabled = on;
    statusEl.setAttribute('aria-busy', on ? 'true' : 'false');
    if (on && !quiet) showStatus('加载中…');
  }

  // 精选：纯手选池（后端 /random 已改为手选 + 京东/淘宝混合）
  function loadFeatured() {
    var token = ++viewToken;
    state.mode = 'featured';
    moreBtn.hidden = true;
    showSkeleton(8);
    setLoading(true, true);
    var action = loadActions.featured = function () { loadFeatured(); };
    var url = buildUrl('/random', [ [ 'limit', 10 ] ]);
    request(url, function (err, d) {
      if (token !== viewToken) return; // 竞态：已有更新的视图加载，丢弃过期响应
      setLoading(false);
      if (err) { showStatus('加载失败，请稍后重试。', action); return; }
      state.list = pickList(d);
      render(sortList(state.list), false);
    }, { cache: true });
  }

  // 榜单：日/周/月
  function loadRank(period) {
    var token = ++viewToken;
    state.mode = 'rank';
    state.period = period;
    moreBtn.hidden = true;
    showSkeleton(8);
    setLoading(true, true);
    var action = loadActions.rank = function () { loadRank(period); };
    var url = buildUrl('/rank', [ [ 'period', period ], [ 'limit', 20 ] ]);
    request(url, function (err, d) {
      if (token !== viewToken) return;
      setLoading(false);
      if (err) { showStatus('加载失败，请稍后重试。', action); return; }
      state.list = pickList(d);
      render(sortList(state.list), false);
    }, { cache: true });
  }

  // 搜索 / 分页
  function loadSearch(reset) {
    var token = reset ? ++viewToken : viewToken;
    state.mode = 'search';
    if (reset) { state.page = 1; state.list = []; showSkeleton(8); setLoading(true, true); }
    else setLoading(true);
    var action = loadActions.search = function () { loadSearch(reset); };
    var url = buildUrl('/paging', [ [ 'search', state.search ], [ 'page', state.page ], [ 'pageSize', PAGE_SIZE ] ]);
    request(url, function (err, d) {
      if (reset && token !== viewToken) return;
      setLoading(false);
      if (err) { showStatus('加载失败，请稍后重试。', action); return; }
      var list = pickList(d);
      state.list = state.list.concat(list);
      render(reset ? sortList(state.list) : list, !reset);
      var count = Number(d && d.count) || 0;
      state.hasMore = state.page * PAGE_SIZE < count;
      moreBtn.hidden = !(state.hasMore && list.length);
    }, { cache: false });
  }

  function setActiveTab(period) {
    var activeTabId = null;
    Array.prototype.forEach.call(tabs.children, function (t) {
      var active = t.getAttribute('data-period') === period;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
      // roving tabindex：仅当前 tab 可聚焦，其余移出 Tab 序列（C7）
      t.tabIndex = active ? 0 : -1;
      if (active) activeTabId = t.id;
    });
    if (activeTabId) grid.setAttribute('aria-labelledby', activeTabId);
  }

  function init() {
    grid = $('cpGrid'); statusEl = $('cpState'); moreBtn = $('cpMore');
    tabs = $('cpTabs'); searchForm = $('cpSearchForm'); searchInput = $('cpSearchInput');
    sortSelect = $('cpSort');
    if (!grid || !statusEl) return;

    Array.prototype.forEach.call(tabs.children, function (t) {
      t.addEventListener('click', function () {
        var period = t.getAttribute('data-period');
        setActiveTab(period);
        loadRank(period);
      });
    });

    // 可访问性（C7）：tablist 支持左右方向键切换
    tabs.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var items = Array.prototype.slice.call(tabs.children);
      var idx = items.indexOf(document.activeElement);
      if (idx < 0) return;
      var next = e.key === 'ArrowRight' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
      items[next].focus();
      items[next].click();
      e.preventDefault();
    });

    if (sortSelect) {
      sortSelect.addEventListener('change', function () {
        state.sort = sortSelect.value;
        // 已有数据则按新规则重排当前视图（搜索态保留已累计的分页结果）
        if (state.list.length) render(sortList(state.list), false);
      });
    }

    searchForm.addEventListener('submit', function (e) {
      e.preventDefault();
      state.search = (searchInput.value || '').trim();
      setActiveTab('');
      if (!state.search) { loadFeatured(); return; }
      if (global.CouponStore) global.CouponStore.pushSearch(state.search);
      loadSearch(true);
      renderHistory();
    });

    moreBtn.addEventListener('click', function () {
      if (state.loading || !state.hasMore) return;
      state.page += 1;
      loadSearch(false);
    });

    // URL 直达搜索：/?s=关键词（首页热门词 chip 的落地方式，零后端）
    var preKw = '';
    if (global.URLSearchParams) {
      try { preKw = (new URLSearchParams(global.location.search).get('s') || '').trim(); } catch (e) { /* 忽略 */ }
    }
    if (preKw) {
      state.search = preKw;
      if (searchInput) searchInput.value = preKw;
      setActiveTab('');
      loadSearch(true);
    } else {
      loadFeatured();
    }

    renderHistory();
  }

  // 搜索历史 chip 行（store.js 落本地）：点击回填输入框并重新搜索
  function renderHistory() {
    var box = $('cpHistory');
    if (!box || !global.CouponStore) return;
    var arr = global.CouponStore.searches();
    box.innerHTML = '';
    if (!arr.length) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('span', 'cp-his-label', '最近搜索'));
    arr.slice(0, 8).forEach(function (kw) {
      var b = el('button', 'cp-his-chip', kw);
      b.type = 'button';
      b.addEventListener('click', function () {
        searchInput.value = kw;
        if (searchForm.requestSubmit) searchForm.requestSubmit();
        else searchForm.dispatchEvent(new Event('submit', { cancelable: true }));
      });
      box.appendChild(b);
    });
    var clear = el('button', 'cp-his-clear', '清空');
    clear.type = 'button';
    clear.setAttribute('aria-label', '清空搜索历史');
    clear.addEventListener('click', function () {
      global.CouponStore.clearSearches();
      renderHistory();
    });
    box.appendChild(clear);
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
