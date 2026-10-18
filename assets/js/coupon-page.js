/* ==========================================================================
   coupon-page.js · 小满券仓领券中心页交互（coupon.zangeng.com）
   —— 动态请求后端优惠券接口（当前数据源京东，京东 / 淘宝等多平台可后续接入），支持：每日精选（手选池）、日/周/月榜单、关键词搜索 + 分页加载更多。
   所有请求携带 mainUrl，经后端 sourceGuard 放行（本站域须已登记，见 main-api scripts/register-static-projects.js）。
   静默失败：接口异常 / 空数据都不报错，给出友好空态（并提供「重试」）。

   健壮性（C3）：AbortController 超时 + 自增 token 丢弃过期响应（防切 tab/搜索乱序覆盖）+ 同参短时内存缓存。
   曝光埋点（C2）：券卡带 data-case，由 conversion.js 观察视口产出「曝光→点击」归因。
   防 CLS（C4）：卡片图带 width/height，配合 coupon.css 的 aspect-ratio 占位。
   排序透出（C8）：默认按「省钱力度」（券面额 + 折扣率）重排，兼顾券面额 / 到手价客户端排序（低成本，不改后端分页语义）。
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

  var state = { mode: 'featured', period: 'week', search: '', page: 1, hasMore: false, loading: false, sort: '', platform: '', list: [] };

  var grid, statusEl, moreBtn, tabs, searchForm, searchInput, sortSelect;
  var recGrid, recSection;
  var loadActions = {}; // name -> function，供错误态「重试」复用最近一次加载动作

  // 短时内存缓存：url -> { t, data }
  var memCache = {};
  // 竞态令牌：每次触发一次「视图级」加载就自增，回调仅当令牌仍为最新时才落 DOM
  var viewToken = 0;

  var doc = global.document; // 本模块多处用裸 doc 建 DOM（Top10/热搜词/氛围条/sparkline），口径同 drops-page.js/detail-page.js
  function $(id) { return global.document.getElementById(id); }

  // 构建期快照：后端不可达时回退渲染最近一次成功取到的券（data/coupon-snapshot.json，nginx 已放行）
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
    else if (state.sort === 'priceAsc') arr.sort(function (a, b) { return (Number(a.price) || 0) - (Number(b.price) || 0); });
    else if (state.sort === 'priceDesc') arr.sort(function (a, b) { return (Number(b.price) || 0) - (Number(a.price) || 0); });
    return arr;
  }

  // 平台筛选（数据带 platform 后才显示；京东/淘宝来源由中台归并时注入）
  function filterPlat(list) {
    if (!state.platform) return list;
    return list.filter(function (c) { return (c.platform || 'jd') === state.platform; });
  }
  function currentView() { return sortList(filterPlat(state.list)); }

  // 猜你喜欢（M1）：基于本地 recent + searches 信号，对 /random 池做子串匹配重排
  function tokenizeTerm(term) {
    var out = [];
    var t = String(term || '').trim().toLowerCase();
    if (!t) return out;
    out.push(t);
    var cjk = t.replace(/[a-z0-9\s]/gi, '');
    for (var i = 0; i + 2 <= cjk.length; i++) out.push(cjk.slice(i, i + 2)); // CJK 二元分词
    return out;
  }
  function buildTermScores(terms) {
    var map = {};
    terms.forEach(function (term) {
      tokenizeTerm(term).forEach(function (tok) {
        if (tok.length < 2) return;
        map[tok] = (map[tok] || 0) + 1;
      });
    });
    return map;
  }
  function matchScore(title, tokenMap) {
    var t = String(title || '').toLowerCase();
    var s = 0;
    for (var tok in tokenMap) { if (t.indexOf(tok) >= 0) s += tokenMap[tok]; }
    return s;
  }
  function loadRecommend() {
    if (!recGrid || !recSection || !global.CouponStore) return;
    var terms = global.CouponStore.recommendTerms();
    if (!terms.length) { recSection.hidden = true; return; }
    var seen = global.CouponStore.seenIds();
    var tokenMap = buildTermScores(terms);
    var url = buildUrl('/random', [ [ 'limit', 50 ] ]);
    request(url, function (err, d) {
      if (err) { recSection.hidden = true; return; }
      var scored = [];
      pickList(d).forEach(function (c) {
        var cid = String(c.tao_id || c._id || '');
        if (seen[cid]) return;
        var s = matchScore(c.title || '', tokenMap);
        if (s <= 0) return;
        scored.push({ c: c, s: s });
      });
      scored.sort(function (a, b) { return b.s - a.s; });
      var top = scored.slice(0, 10).map(function (x) { return x.c; });
      if (!top.length) { recSection.hidden = true; return; }
      recSection.hidden = false;
      recGrid.innerHTML = '';
      top.forEach(function (c) { var card = buildCard(c); recGrid.appendChild(card); attachStar(card, c); });
      if (global.Conv && global.Conv.reobserve) global.Conv.reobserve();
    }, { cache: true });
  }

  // 热搜词（M6）：服务端 Redis zset 计数 TopN，渲染「大家都在搜」
  function loadHotWords() {
    var box = $('cpHotWords');
    if (!box) return;
    var url = buildUrl('/hotwords', [ [ 'limit', 12 ] ]);
    request(url, function (err, d) {
      if (err) return;
      var list = (d && d.list) || [];
      if (!list.length) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = '';
      list.forEach(function (h) {
        var a = doc.createElement('button');
        a.type = 'button'; a.className = 'cp-his-chip';
        a.textContent = h.word;
        a.setAttribute('data-track', 'coupon_search');
        a.setAttribute('data-track-props', JSON.stringify({ type: 'hotword', word: h.word }));
        a.addEventListener('click', function () {
          if (global.CouponStore) global.CouponStore.pushSearch(h.word);
          loadSearch(h.word);
        });
        box.appendChild(a);
      });
    }, { cache: true });
  }

  function parseProps(el) {
    try { return JSON.parse(el.getAttribute('data-track-props') || '{}'); } catch (e) { return null; }
  }

  // 历史低价走势（M7）：一页券卡一次批量取，画 sparkline 到价格行
  function loadPriceTrends(gridEl) {
    if (!gridEl) return;
    var cards = gridEl.querySelectorAll('a.cp-card[data-track-props]');
    var ids = [];
    for (var i = 0; i < cards.length; i++) {
      var p = parseProps(cards[i]);
      if (p && p.coupon_id) ids.push(p.coupon_id);
    }
    if (!ids.length) return;
    var url = buildUrl('/priceBatch', [ [ 'ids', ids.join(',') ] ]);
    request(url, function (err, d) {
      if (err) return;
      var map = (d && d.map) || {};
      for (var j = 0; j < cards.length; j++) {
        var pp = parseProps(cards[j]);
        if (!pp) continue;
        var series = map[pp.coupon_id];
        if (series && series.length >= 2) drawSpark(cards[j], series);
      }
    }, { cache: true });
  }

  function drawSpark(card, series) {
    var price = card.querySelector('.cp-price');
    if (!price || price.querySelector('.cp-spark')) return;
    var vals = series.map(function (s) { return Number(s.price) || 0; }).filter(Boolean);
    if (vals.length < 2) return;
    var w = 54, h = 16, pad = 2;
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = (max - min) || 1;
    var ns = 'http://www.w3.org/2000/svg';
    var svg = doc.createElementNS(ns, 'svg');
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    svg.setAttribute('class', 'cp-spark'); svg.setAttribute('aria-hidden', 'true');
    var pts = vals.map(function (v, i) {
      var x = pad + (w - 2 * pad) * (i / (vals.length - 1));
      var y = h - pad - (h - 2 * pad) * ((v - min) / span);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var poly = doc.createElementNS(ns, 'polyline');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', vals[vals.length - 1] <= vals[0] ? '#2bbf6a' : '#e4393c');
    poly.setAttribute('stroke-width', '1.5');
    svg.appendChild(poly);
    price.appendChild(svg);
  }

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
  // 旧实现写死 京东/淘宝/拼多多/抖音，数据单一平台时多数 chip 恒为 0 成「死入口」。
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
        if (state.list.length) render(currentView(), false);
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
    // 曝光埋点（C2）：data-case 供 conversion.js 视口观察；点击埋点保持 data-track
    var cid = String(c.tao_id || c._id || '');
    if (cid) a.setAttribute('data-case', 'coupon:' + cid);
    a.setAttribute('data-track', 'coupon_click');
    a.setAttribute('data-track-props', JSON.stringify({
      coupon_id: cid, title: c.title || '', mode: state.mode, period: state.mode === 'rank' ? state.period : '',
      exp: (global.__exp && global.__exp.bucket) || '',
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
    // 时效标签（今日新增）：createTime 在 24h 内
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
      var nodes = global.document.querySelectorAll('.cp-countdown');
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

  /* ---------------- W4 情报条 / 今日必抢 Top10 / 失效氛围条（本地对已加载数据估算，无埋点无 PII） ---------------- */
  var intel = { top10Done: false, moodTimer: 0 };

  function money(v) {
    v = Number(v) || 0;
    return v >= 10000 ? (Math.round(v / 100) / 100) + ' 万' : String(Math.round(v));
  }

  function renderIntelBar() {
    var bar = $('cpIntelBar');
    if (!bar || !state.list.length) return;
    var sum = 0;
    state.list.forEach(function (c) { sum += Number(c.couponDiscount) || 0; });
    var n1 = $('cpIntelCount'), n2 = $('cpIntelSave');
    if (n1) n1.textContent = String(state.list.length);
    if (n2) n2.textContent = money(sum);
    bar.hidden = false;
  }

  // 与券卡同口径的跳转链（clickURL → couponUrl → item_url）
  function linkOf(c) {
    return safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url) || '';
  }

  // Top10 分数：省钱力度 + 新鲜度加权（今日新增 +50），与 saveScore/build.js 同口径基础上叠加
  function topScore(c) {
    var s = saveScore(c);
    var ct = Number(c.createTime) || 0;
    if (ct && Date.now() - ct < 86400000) s += 50;
    return s;
  }

  function renderTop10() {
    var wrap = $('cpTop10Wrap'), box = $('cpTop10');
    if (!wrap || !box || intel.top10Done || state.list.length < 3) return;
    var top = state.list.slice().sort(function (a, b) { return topScore(b) - topScore(a); }).slice(0, 10);
    intel.top10Done = true;
    box.innerHTML = '';
    top.forEach(function (c, i) {
      var link = linkOf(c);
      if (!link) return;
      var a = doc.createElement('a');
      a.className = 'cp-top-chip';
      a.href = link;
      a.target = '_blank';
      a.rel = 'sponsored noopener';
      a.setAttribute('role', 'listitem');
      a.setAttribute('data-track', 'top10_click');
      a.setAttribute('data-track-props', JSON.stringify({ pos: i + 1, coupon_id: String(c.tao_id || c._id || '') }));
      var off = Number(c.couponDiscount) || 0, quota = Number(c.couponQuota) || 0;
      var rank = el('span', 'cp-top-rank', String(i + 1));
      var name = el('span', 'cp-top-name', String(c.title || '优惠券').slice(0, 18));
      a.appendChild(rank); a.appendChild(name);
      if (off > 0) a.appendChild(el('span', 'cp-top-off', quota > 0 ? ('满' + quota + '减' + off) : ('¥' + off)));
      box.appendChild(a);
    });
    if (box.children.length) wrap.hidden = false;
  }

  // 临近失效氛围条：48h 内到期的券轮播（每 5s 一换），营造实时紧迫感；无则隐藏
  function renderMoodBar() {
    var bar = $('cpMoodBar');
    if (!bar) return;
    var soon = state.list.filter(function (c) {
      var ms = endMs(c.couponEndTime);
      return ms > Date.now() && ms - Date.now() < 48 * 3600000;
    }).sort(function (a, b) { return endMs(a.couponEndTime) - endMs(b.couponEndTime); }).slice(0, 8);
    clearInterval(intel.moodTimer);
    if (!soon.length) { bar.hidden = true; return; }
    var idx = 0;
    function show() {
      var c = soon[idx % soon.length];
      var hrs = Math.max(1, Math.round((endMs(c.couponEndTime) - Date.now()) / 3600000));
      bar.innerHTML = '';
      var a = doc.createElement('a');
      a.href = linkOf(c) || '#';
      if (linkOf(c)) { a.target = '_blank'; a.rel = 'sponsored noopener'; }
      a.setAttribute('data-track', 'mood_click');
      a.textContent = '⏰ 即将失效：' + String(c.title || '优惠券').slice(0, 20) + ' · 剩 ' + hrs + ' 小时';
      bar.appendChild(a);
      idx++;
    }
    show();
    bar.hidden = false;
    intel.moodTimer = setInterval(show, 5000);
  }

  function render(list, append) {
    rebuildPlatBar();
    if (!append) grid.innerHTML = '';
    if (!list.length) {
      if (!append) { showStatus('暂无优惠券，换个关键词或稍后再试。'); }
      return;
    }
    hideStatus();
    list.forEach(function (c) { var card = buildCard(c); grid.appendChild(card); attachStar(card, c); });
    // 动态新增的券卡带 data-case，通知归因层补观察（否则首屏 boot 时的 observer 覆盖不到）
    if (global.Conv && global.Conv.reobserve) global.Conv.reobserve();
    // W4：情报条 / Top10 / 氛围条（基于当前已加载集合，静默降级）
    try { renderIntelBar(); renderTop10(); renderMoodBar(); } catch (e) { /* 忽略 */ }
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

  // 后端不可达、用构建快照兜底时：灰化券卡 + 状态区加警示样式（快照券可能已失效，提示用户核对）
  function markStale(on) {
    if (grid) grid.classList.toggle('is-stale', !!on);
    if (statusEl) statusEl.classList.toggle('is-fallback', !!on);
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
    markStale(false);
    request(url, function (err, d) {
      if (token !== viewToken) return; // 竞态：已有更新的视图加载，丢弃过期响应
      setLoading(false);
      if (err) {
        loadSnapshot(function (snap) {
          if (snap && snap.featured && snap.featured.length) {
            state.list = snap.featured;
            render(currentView(), false);
            markStale(true);
            showStatus('⚠ 实时数据暂时不可用，已用构建快照兜底（' + snapStamp(snap) + '），券可能已失效，下单前请核对。');
          } else {
            showStatus('加载失败，请稍后重试。', action);
          }
        });
        return;
      }
      state.list = pickList(d);
      render(currentView(), false);
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
    markStale(false);
    request(url, function (err, d) {
      if (token !== viewToken) return;
      setLoading(false);
      if (err) {
        loadSnapshot(function (snap) {
          var arr = snap && snap.rank && (snap.rank[period] || []);
          if (arr && arr.length) {
            state.list = arr;
            render(currentView(), false);
            markStale(true);
            showStatus('⚠ 实时数据暂时不可用，已用构建快照兜底（' + snapStamp(snap) + '）的' + ({ day: '日', week: '周', month: '月' }[period] || '') + '榜，券可能已失效，下单前请核对。');
          } else {
            showStatus('加载失败，请稍后重试。', action);
          }
        });
        return;
      }
      state.list = pickList(d);
      render(currentView(), false);
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
    markStale(false);
    request(url, function (err, d) {
      if (reset && token !== viewToken) return;
      setLoading(false);
      if (err) {
        var kw = state.search;
        loadSnapshot(function (snap) {
          var arr = (snap && snap.browse) || [];
          if (kw) arr = arr.filter(function (c) { return (c.title || '').indexOf(kw) >= 0; });
          if (arr.length) {
            state.page = 1;
            state.list = arr;
            render(sortList(arr), false);
            markStale(true);
            showStatus(kw ? ('⚠ 实时搜索暂时不可用，已用构建快照兜底（' + snapStamp(snap) + '）展示匹配「' + kw + '」的券，可能已失效，下单前请核对。') : '⚠ 实时数据暂时不可用，已用构建快照兜底（' + snapStamp(snap) + '），券可能已失效，下单前请核对。');
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
      render(sortList(filterPlat(appendMode ? list : state.list)), appendMode);
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
    ensurePlatBar();
    // 默认排序跟随 select 初始选中项（省钱力度↓），与预渲染顺序一致
    if (sortSelect) state.sort = sortSelect.value || '';

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
        // 已有数据则按新规则重排当前视图（搜索态保留已累计的分页结果；尊重平台筛选）
        if (state.list.length) render(currentView(), false);
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
    loadHotWords();
    // 猜你喜欢（M1）：本地有浏览/搜索信号才拉取并展示
    recGrid = $('cpRecGrid'); recSection = $('cpRecSection');
    loadRecommend();
    // 历史低价走势（M7）：网格变化（含分页追加）后批量取趋势画 sparkline
    if (grid && 'MutationObserver' in global) {
      var _pt;
      var _mo = new MutationObserver(function () {
        global.clearTimeout(_pt);
        _pt = global.setTimeout(function () { loadPriceTrends(grid); }, 500);
      });
      _mo.observe(grid, { childList: true });
    }
    var rd = $('cpRecDismiss');
    if (rd) rd.addEventListener('click', function () { if (recSection) recSection.hidden = true; });
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
