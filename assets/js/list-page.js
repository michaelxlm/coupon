/* ==========================================================================
   list-page.js · 小满券仓通用券列表页交互（browse / rank / category 三模式）
   —— 依 <body data-mode> 分支驱动，复用中台优惠券前台接口（当前数据源京东，后续可接多平台），纯静态、静默失败。
     · browse   ：paging 无关键词，无限「加载更多」分页浏览全部好物。
     · rank     ：日 / 周 / 月榜单 tab，一次取 RANK_LIMIT=100 条后前端本地分页（后端无 page 参数）。
     · category ：paging?search=<data-kw>，关键词映射品类 + 加载更多。
   健壮性对齐 coupon-page.js：AbortController 超时 + 自增 token 丢弃过期响应 + 同参短时内存缓存。
   曝光埋点：券卡带 data-case，由 conversion.js 观察视口产出「曝光→点击」归因。
   防 CLS：卡片图带 width/height，配合 coupon.css 的 aspect-ratio 占位。
   排序：默认按「省钱力度」（券面额 + 折扣率）重排，兼顾券面额 / 到手价客户端重排（不改后端分页语义）。
   本地功能：券卡收藏星标（store.js）+ 骨架屏加载态 + 到手价区间前端筛选（browse/category）。
   ========================================================================== */
(function (global) {
  'use strict';

  var API_BASE = 'https://api.xuyiheng.com';
  var MAIN_URL = 'coupon.zangeng.com';
  var PREFIX = '/api/v1/front/coupon/jd';
  var PAGE_SIZE = 20;
  var RANK_LIMIT = 100;
  var TIMEOUT_MS = 12000;
  var CACHE_TTL = 30000;

  var doc = global.document;
  var body = doc.body;
  var mode = body.getAttribute('data-mode') || 'browse';
  var kw = body.getAttribute('data-kw') || '';
  // 专题落地页（M10）：模板注入 window.__TOPIC__ 时补齐标题
  if (global.__TOPIC__) {
    if (global.__TOPIC__.title) doc.title = global.__TOPIC__.title + ' · 小满券仓';
    var tt = $('topicTitle'); if (tt) tt.textContent = global.__TOPIC__.title || '';
  }

  var state = { period: 'week', page: 1, hasMore: false, loading: false, sort: '', price: '', platform: '', list: [], rankAll: [], rankShown: 0 };

  var grid, statusEl, moreBtn, tabs, sortSelect, priceSelect;
  var loadActions = {};
  var memCache = {};
  var viewToken = 0;

  function $(id) { return doc.getElementById(id); }

  // 构建期快照：后端不可达时回退渲染（data/coupon-snapshot.json，nginx 已放行）
  var snapshotCache = null;
  var snapshotLoading = false;
  function loadSnapshot(done) {
    if (snapshotCache) { done(snapshotCache); return; }
    if (snapshotLoading) { return; }
    snapshotLoading = true;
    var ctrl = global.AbortController ? new global.AbortController() : null;
    var timer = global.setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } } }, TIMEOUT_MS);
    global.fetch('/data/coupon-snapshot.json', { cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (json) { global.clearTimeout(timer); snapshotCache = json || {}; done(snapshotCache); })
      .catch(function () { global.clearTimeout(timer); done(null); });
  }

  // 快照更新时间戳（兜底时告知用户数据有多旧）
  function snapStamp(snap) {
    try {
      var t = snap && snap.updatedAt ? new Date(snap.updatedAt) : null;
      if (!t || isNaN(t.getTime())) return '';
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + ' ' + p(t.getHours()) + ':' + p(t.getMinutes());
    } catch (e) { return ''; }
  }

  // 券到期时间解析：兼容时间戳（秒/毫秒）与日期字符串；解析不出返回 0
  function endMs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    var s = String(v).trim();
    if (!s) return 0;
    if (/^\d+$/.test(s)) { var n = Number(s); return s.length >= 12 ? n : n * 1000; }
    var t = Date.parse(s.replace(/\.\d+/, '').replace(/-/g, '/'));
    return isNaN(t) ? 0 : t;
  }
  // 即将失效文案（3 天内）；无到期时间 / 已过期返回 ''
  function expireLabel(c) {
    var ms = endMs(c && c.couponEndTime);
    if (!ms) return '';
    var diff = ms - Date.now();
    if (diff <= 0) return '';
    var d = Math.ceil(diff / 86400000);
    return d <= 1 ? '即将到期' : (d + '天后失效');
  }

  // 即将失效排序权重（需求 4）：有未来到期时间者按到期早晚升序（越早越前）；无到期/已过期一律排最后。
  // 与 coupon-page.js 同口径。
  function expireRank(c) {
    var ms = endMs(c && c.couponEndTime);
    return (ms && ms > Date.now()) ? ms : Number.MAX_SAFE_INTEGER;
  }

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

  function pickList(d) {
    if (!d) return [];
    if (Array.isArray(d.data)) return d.data;
    if (Array.isArray(d.list)) return d.list;
    if (Array.isArray(d)) return d;
    return [];
  }

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // value（省钱力度）与构建期 build.js sortByValue 同口径：分数 = 券面额 + 折扣率×100，同分按到手价低者前
  function saveScore(c) {
    var off = Number(c.couponDiscount) || 0;
    var price = Number(c.price) || 0;
    return off > 0 ? off + (off / (price + off)) * 100 : 0;
  }

  function sortList(list) {
    if (!state.sort) return list;
    var arr = list.slice();
    if (state.sort === 'value') arr.sort(function (a, b) { var d = saveScore(b) - saveScore(a); return d !== 0 ? d : ((Number(a.price) || 0) - (Number(b.price) || 0)); });
    else if (state.sort === 'discount') arr.sort(function (a, b) { return (Number(b.couponDiscount) || 0) - (Number(a.couponDiscount) || 0); });
    else if (state.sort === 'expire') arr.sort(function (a, b) { return expireRank(a) - expireRank(b); });
    else if (state.sort === 'priceAsc') arr.sort(function (a, b) { return (Number(a.price) || 0) - (Number(b.price) || 0); });
    else if (state.sort === 'priceDesc') arr.sort(function (a, b) { return (Number(b.price) || 0) - (Number(a.price) || 0); });
    return arr;
  }

  // 平台筛选（数据带 platform 后才显示；京东/淘宝来源由中台归并时注入）
  function filterPlat(list) {
    if (!state.platform) return list;
    return list.filter(function (c) { return (c.platform || 'jd') === state.platform; });
  }
  function currentView() { return sortList(filterPlat(state.list).filter(matchPrice)); }
  // 平台展示名（chip 标签用）
  var PLATFORM_LABELS = { jd: '京东', taobao: '淘宝', pdd: '拼多多', douyin: '抖音', other: '其他' };
  function ensurePlatBar() {
    if ($('cpPlat')) return;
    var host = global.document.querySelector('.cp-toolbar');
    if (!host) return;
    var bar = el('div', 'cp-plat');
    bar.id = 'cpPlat';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', '平台筛选');
    bar.hidden = true;
    host.appendChild(bar);
  }
  // chip 按已加载数据里真实出现的平台生成：
  // 旧实现写死 京东/淘宝/拼多多，数据单一平台时多数 chip 恒为 0 成「死入口」。
  // 现在只渲染确有数据的平台；单一平台时整条收起（筛选无意义，避免假条目误导）。
  function rebuildPlatBar() {
    var bar = $('cpPlat');
    if (!bar) return;
    var seen = {};
    state.list.forEach(function (c) { if (c) seen[c.platform || 'jd'] = 1; });
    var plats = Object.keys(seen);
    if (plats.length <= 1) { bar.hidden = true; bar.innerHTML = ''; return; }
    if (state.platform && !seen[state.platform]) state.platform = ''; // 选中平台已不在数据里 → 回「全部」
    bar.hidden = false;
    bar.innerHTML = '';
    [ [ '', '全部' ] ].concat(plats.map(function (p) { return [ p, PLATFORM_LABELS[p] || p ]; })).forEach(function (o) {
      var b = el('button', 'cp-plat-chip' + (state.platform === o[0] ? ' is-active' : ''), o[1]);
      b.type = 'button';
      b.setAttribute('data-plat', o[0]);
      b.addEventListener('click', function () {
        state.platform = o[0];
        Array.prototype.forEach.call(bar.children, function (x) { x.classList.toggle('is-active', x.getAttribute('data-plat') === o[0]); });
        if (!state.list.length) return;
        // 榜单：筛选后回到第一页（rankView 自带 slice，避免把 100 条一次铺满）
        if (mode === 'rank') {
          state.rankShown = Math.min(PAGE_SIZE, rankFiltered().length);
          render(rankView(), false);
          updateRankMore();
          return;
        }
        render(currentView(), false);
      });
      bar.appendChild(b);
    });
  }

  function buildCard(c) {
    var a = el('a', 'cp-card');
    var link = safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url);
    a.href = link || '#';
    if (link) { a.target = '_blank'; a.setAttribute('rel', 'sponsored noopener'); }
    else { a.classList.add('is-dead'); a.setAttribute('aria-disabled', 'true'); }
    // 平台色描边（京东红 / 淘宝橙）供 CSS 区分
    a.setAttribute('data-plat', c.platform === 'taobao' ? 'taobao' : c.platform === 'pdd' ? 'pdd' : 'jd');
    // 超值 / 火爆 飘带（按券面额力度）
    var off = Number(c.couponDiscount) || 0;
    if (off >= 100) a.appendChild(el('span', 'cp-hot cp-hot--fire', '火爆'));
    else if (off >= 50) a.appendChild(el('span', 'cp-hot', '超值'));
    var cid = String(c.tao_id || c._id || '');
    if (cid) a.setAttribute('data-case', 'coupon:' + cid);
    a.setAttribute('data-track', 'coupon_click');
    a.setAttribute('data-track-props', JSON.stringify({
      coupon_id: cid, title: c.title || '', mode: mode, period: mode === 'rank' ? state.period : '', kw: kw,
    }));
    var imgSrc = safeUrl(c.pict_url);
    if (imgSrc) {
      var img = el('img');
      img.alt = c.title || '';
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
    var quota = Number(c.couponQuota) || 0;
    if (off > 0) price.appendChild(el('span', 'cp-off', quota > 0 ? ('满' + quota + '减' + off) : ('立减¥' + off)));
    var finalPrice = Number(c.price) || 0;
    if (finalPrice > 0) price.appendChild(el('span', 'cp-final', '¥' + finalPrice));
    // 限时倒计时（couponEndTime 24h 内实时刷新）；否则展示即将失效文案
    var end = endMs(c.couponEndTime);
    if (end) {
      var diff = end - Date.now();
      if (diff > 0 && diff <= 86400000) {
        var cd = el('span', 'cp-countdown', '');
        cd.setAttribute('data-end', String(end));
        price.appendChild(cd);
        startCountdown();
      } else {
        var exLabel = expireLabel(c);
        if (exLabel) price.appendChild(el('span', 'cp-expire', exLabel));
      }
    }
    a.appendChild(price);
    var ct = Number(c.createTime) || 0;
    if (ct && (Date.now() - ct) < 24 * 60 * 60 * 1000) a.appendChild(el('span', 'cp-fresh', '今日新增'));
    return a;
  }

  // 限时倒计时：全站单一定时器，每秒刷新所有 .cp-countdown（couponEndTime 24h 内券卡）
  var countdownStarted = false;
  function startCountdown() {
    if (countdownStarted) return;
    countdownStarted = true;
    setInterval(function () {
      var now = Date.now();
      var nodes = doc.querySelectorAll('.cp-countdown');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var end = Number(n.getAttribute('data-end')) || 0;
        var d = end - now;
        if (d <= 0) { n.textContent = '已结束'; n.classList.add('is-ended'); continue; }
        var p2 = function (x) { return (x < 10 ? '0' : '') + x; };
        var dd = Math.floor(d / 86400000);
        var hh = Math.floor((d % 86400000) / 3600000);
        var mm = Math.floor((d % 3600000) / 60000);
        var ss = Math.floor((d % 60000) / 1000);
        n.textContent = '⏱ ' + (dd > 0 ? (dd + '天 ') : '') + p2(hh) + ':' + p2(mm) + ':' + p2(ss);
      }
    }, 1000);
  }

  // 到手价区间前端筛选（性能小件）：仅对已加载集合过滤，不改后端分页语义
  function matchPrice(c) {
    if (!state.price) return true;
    var p = Number(c.price) || 0;
    if (state.price === 'lt50') return p > 0 && p < 50;
    if (state.price === 'p50_100') return p >= 50 && p < 100;
    if (state.price === 'p100_300') return p >= 100 && p < 300;
    if (state.price === 'gt300') return p >= 300;
    return true;
  }

  // 收藏星标（store.js 提供）：运行时卡与预渲染卡同一套交互
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

  // 骨架屏：重置加载时先占位，避免空白跳变
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

  function render(list, append) {
    rebuildPlatBar();
    if (!append) grid.innerHTML = '';
    if (!list.length) {
      if (!append) { showStatus(state.price && state.list.length ? '已加载的券里没有符合该价格区间的，试试更大区间或加载更多。' : '暂无优惠券，换个关键词或稍后再试。'); }
      return;
    }
    hideStatus();
    list.forEach(function (c) { var card = buildCard(c); grid.appendChild(card); attachStar(card, c); });
    if (global.Conv && global.Conv.reobserve) global.Conv.reobserve();
  }

  function showStatus(text, retryFn) {
    statusEl.textContent = text;
    statusEl.hidden = false;
    statusEl.setAttribute('aria-busy', 'false');
    var old = $('listRetry');
    if (old) old.parentNode && old.parentNode.removeChild(old);
    if (retryFn) {
      var btn = el('button', 'btn btn-ghost cp-retry', '重试');
      btn.id = 'listRetry';
      btn.type = 'button';
      btn.addEventListener('click', function () { retryFn(); });
      statusEl.appendChild(doc.createElement('br'));
      statusEl.appendChild(btn);
    }
  }

  function hideStatus() {
    statusEl.hidden = true;
    statusEl.setAttribute('aria-busy', 'false');
    var old = $('listRetry');
    if (old) old.parentNode && old.parentNode.removeChild(old);
  }

  // 后端不可达、用构建快照兜底时：灰化券卡 + 状态区加警示样式（快照券可能已失效，提示用户核对）
  function markStale(on) {
    if (grid) grid.classList.toggle('is-stale', !!on);
    if (statusEl) statusEl.classList.toggle('is-fallback', !!on);
  }

  function setLoading(on, quiet) {
    state.loading = on;
    if (moreBtn) moreBtn.disabled = on;
    statusEl.setAttribute('aria-busy', on ? 'true' : 'false');
    if (on && !quiet) showStatus('加载中…');
  }

  // 榜单本地分页：一次取满 RANK_LIMIT 条存 rankAll，rankShown 控制已展示条数（筛选/排序作用于全量后截断）
  function rankFiltered() { return sortList(filterPlat(state.rankAll).filter(matchPrice)); }
  function rankView() { return rankFiltered().slice(0, state.rankShown); }
  function updateRankMore() {
    if (!moreBtn || mode !== 'rank') return;
    var left = rankFiltered().length - state.rankShown;
    if (left > 0) {
      moreBtn.hidden = false;
      moreBtn.textContent = '加载更多（还有 ' + left + ' 条）';
    } else {
      moreBtn.hidden = true;
      moreBtn.textContent = '加载更多';
    }
  }
  function setRankData(list) {
    state.rankAll = list || [];
    state.rankShown = Math.min(PAGE_SIZE, state.rankAll.length);
    state.list = state.rankAll;
    render(rankView(), false);
    updateRankMore();
  }

  // rank：日 / 周 / 月榜单
  function loadRank(period) {
    var token = ++viewToken;
    state.period = period;
    state.rankAll = [];
    state.rankShown = 0;
    if (moreBtn) moreBtn.hidden = true;
    showSkeleton(8);
    setLoading(true, true);
    var action = loadActions.rank = function () { loadRank(period); };
    var url = buildUrl('/rank', [ [ 'period', period ], [ 'limit', RANK_LIMIT ] ]);
    markStale(false);
    request(url, function (err, d) {
      if (token !== viewToken) return;
      setLoading(false);
      if (err) {
        loadSnapshot(function (snap) {
          var arr = snap && snap.rank && (snap.rank[period] || []);
          if (arr && arr.length) {
            setRankData(arr);
            markStale(true);
            showStatus('⚠ 实时数据暂时不可用，已用构建快照兜底（' + snapStamp(snap) + '）的' + ({ day: '日', week: '周', month: '月' }[period] || '') + '榜，券可能已失效，下单前请核对。');
          } else {
            showStatus('加载失败，请稍后重试。', action);
          }
        });
        return;
      }
      setRankData(pickList(d));
    }, { cache: true });
  }

  // browse / category：分页 + 加载更多
  function loadPaging(reset) {
    var token = reset ? ++viewToken : viewToken;
    if (reset) { state.page = 1; state.list = []; showSkeleton(8); setLoading(true, true); }
    else setLoading(true);
    var action = loadActions.paging = function () { loadPaging(reset); };
    var params = [ [ 'page', state.page ], [ 'pageSize', PAGE_SIZE ] ];
    // 非「默认(createTime 倒序)」排序时向后端透传真实排序值（discount=券值优先 / expire=即将失效），由后端保证分页语义
    if (state.sort) params.push([ 'sort', state.sort ]);
    if (mode === 'category' && kw) params.unshift([ 'search', kw ]);
    var url = buildUrl('/paging', params);
    markStale(false);
    request(url, function (err, d) {
      if (reset && token !== viewToken) return;
      setLoading(false);
      if (err) {
        loadSnapshot(function (snap) {
          var arr = [];
          if (mode === 'category') arr = (snap && snap.category && (snap.category[kw] || [])) || [];
          else arr = (snap && snap.browse) || [];
          if (arr.length) {
            state.page = 1;
            state.list = arr;
            var appendMode = false;
            render(currentView(), false);
            markStale(true);
            state.hasMore = false;
            if (moreBtn) moreBtn.hidden = true;
            showStatus('⚠ 实时数据暂时不可用，已用构建快照兜底（' + snapStamp(snap) + '），券可能已失效，下单前请核对。');
          } else {
            showStatus('加载失败，请稍后重试。', action);
          }
        });
        return;
      }
      var list = pickList(d);
      state.list = state.list.concat(list);
      // 排序生效时追加也全量重排保序；无排序时维持新一页追加
      var appendMode = !reset && !state.sort;
      render(sortList(filterPlat(appendMode ? list : state.list).filter(matchPrice)), appendMode);
      var count = Number(d && d.count) || 0;
      state.hasMore = state.page * PAGE_SIZE < count;
      if (moreBtn) moreBtn.hidden = !(state.hasMore && list.length);
    }, { cache: false });
  }

  function setActiveTab(period) {
    if (!tabs) return;
    var activeTabId = null;
    Array.prototype.forEach.call(tabs.children, function (t) {
      var active = t.getAttribute('data-period') === period;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
      t.tabIndex = active ? 0 : -1;
      if (active) activeTabId = t.id;
    });
    if (activeTabId && grid) grid.setAttribute('aria-labelledby', activeTabId);
  }

  function init() {
    grid = $('listGrid'); statusEl = $('listState'); moreBtn = $('listMore');
    tabs = $('rankTabs'); sortSelect = $('listSort'); priceSelect = $('listPrice');
    if (!grid || !statusEl) return;
    ensurePlatBar();
    // 默认排序跟随 select 初始选中项（省钱力度↓），与预渲染顺序一致
    if (sortSelect) state.sort = sortSelect.value || '';

    if (sortSelect) {
      sortSelect.addEventListener('change', function () {
        state.sort = sortSelect.value;
        if (!state.list.length) return;
        // 榜单排序变化回到第一页，避免已展开条数显得「越排越少」
        if (mode === 'rank') {
          state.rankShown = Math.min(PAGE_SIZE, state.rankAll.length);
          render(rankView(), false);
          updateRankMore();
          return;
        }
        render(currentView(), false);
      });
    }

    if (priceSelect) {
      priceSelect.addEventListener('change', function () {
        state.price = priceSelect.value;
        if (!state.list.length) return;
        if (mode === 'rank') {
          state.rankShown = Math.min(PAGE_SIZE, state.rankAll.length);
          render(rankView(), false);
          updateRankMore();
          return;
        }
        render(currentView(), false);
      });
    }

    if (mode === 'rank') {
      if (tabs) {
        Array.prototype.forEach.call(tabs.children, function (t) {
          t.addEventListener('click', function () {
            var period = t.getAttribute('data-period');
            setActiveTab(period);
            loadRank(period);
          });
        });
        tabs.addEventListener('keydown', function (e) {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          var items = Array.prototype.slice.call(tabs.children);
          var idx = items.indexOf(doc.activeElement);
          if (idx < 0) return;
          var next = e.key === 'ArrowRight' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
          items[next].focus();
          items[next].click();
          e.preventDefault();
        });
      }
      // 榜单加载更多：本地分页追加（后端无 page 参数，已一次取满 RANK_LIMIT 条）
      if (moreBtn) {
        moreBtn.addEventListener('click', function () {
          if (state.loading) return;
          var total = rankFiltered().length;
          if (state.rankShown >= total) return;
          var prev = state.rankShown;
          state.rankShown = Math.min(prev + PAGE_SIZE, total);
          render(rankView().slice(prev), true);
          updateRankMore();
        });
      }
      var initial = 'week';
      if (tabs && tabs.querySelector('.is-active')) initial = tabs.querySelector('.is-active').getAttribute('data-period') || 'week';
      setActiveTab(initial);
      loadRank(initial);
      return;
    }

    // browse / category
    if (moreBtn) {
      moreBtn.addEventListener('click', function () {
        if (state.loading || !state.hasMore) return;
        state.page += 1;
        loadPaging(false);
      });
    }
    loadPaging(true);
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
