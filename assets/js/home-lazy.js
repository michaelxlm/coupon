/* home-lazy.js · WO-261 由 scripts/build-home-bundles.js 从源码拼接生成，勿手改。 组成：challenge.js + activities.js（次屏模块（requestIdleCallback 注入，不占首屏）） */

/* ==== challenge.js ==== */
/* ==========================================================================
   challenge.js · 今日省钱挑战（W5 · P3 · 仅首页）
   —— 纯 localStorage 匿名本地实现（2026-10-12 定位决策：不做账号积分体系）：
     · 连续回访天数 streak（按本地日期去重打卡）；
     · 累计省钱力度：监听券卡「去领取」点击（capture 不干扰跳转），
       每张券每天只计一次券面额，估算口径展示于挑战条；
     · 里程碑（3/7/14/30/60/100 天）达成时提示，并可一键生成扫码战报海报
       （复用 share.js，item.link 指回首页承接回流）。
   —— fail-soft：localStorage 不可用（隐私模式）/ DOM 缺失时静默不渲染，不报错。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var KEY = 'coupon_challenge';
  var MILESTONES = [3, 7, 14, 30, 60, 100];

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function yesterdayOf(t) {
    var p = t.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function num(v) { return Math.round((Number(v) || 0) * 100) / 100; }

  function load() {
    try {
      var s = JSON.parse(global.localStorage.getItem(KEY) || '{}');
      return {
        days: Array.isArray(s.days) ? s.days : [],
        total: num(s.total),
        counted: (s.counted && typeof s.counted === 'object') ? s.counted : {},
        milestoneShared: Array.isArray(s.milestoneShared) ? s.milestoneShared : [],
      };
    } catch (e) { return { days: [], total: 0, counted: {}, milestoneShared: [] }; }
  }
  function save(s) {
    try { global.localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* 隐私模式：放弃记录 */ }
  }

  var st = load();

  // 打卡：今天首次运行则续接/重开连续天数
  function checkin() {
    var t = today();
    if (st.days.indexOf(t) !== -1) return;
    if (st.days.length && st.days[st.days.length - 1] === yesterdayOf(t)) st.days.push(t);
    else st.days = [t]; // 断签重开（只保留最近一次连续段，口径简单可解释）
    save(st);
  }

  function streak() { return st.days.length; }

  function nextMilestone() {
    for (var i = 0; i < MILESTONES.length; i++) if (MILESTONES[i] > streak()) return MILESTONES[i];
    return 0;
  }

  // 券卡点击累计（capture 阶段，不拦截默认跳转）：力度从卡面 .cp-off 文案解析（满X减Y / 立减¥Y）
  function offFromCard(a) {
    var node = a.querySelector('.cp-off') ||
      (a.parentElement && a.parentElement.querySelector ? a.parentElement.querySelector('.cp-off') : null);
    if (!node) return 0;
    var txt = node.textContent || '';
    var m1 = /减(\d+(?:\.\d+)?)/.exec(txt);
    if (m1) return num(m1[1]);
    var m2 = /立减[¥￥]?(\d+(?:\.\d+)?)/.exec(txt);
    return m2 ? num(m2[1]) : 0;
  }

  function wireTrack() {
    doc.addEventListener('click', function (e) {
      try {
        var a = e.target && e.target.closest ? e.target.closest('a[data-case^="coupon:"]') : null;
        if (!a) return;
        var id = (a.getAttribute('data-case') || '').replace(/^coupon:/, '');
        if (!id) return;
        var k = id + '@' + today();
        if (st.counted[k]) return;
        var off = offFromCard(a);
        if (!off) return;
        st.counted[k] = 1;
        st.total = num(st.total + off);
        save(st);
        render();
      } catch (err) { /* 记录失败不影响跳转 */ }
    }, true);
  }

  /* ------------------------------ 挑战条 UI ------------------------------ */
  function milestoneReached() {
    for (var i = MILESTONES.length - 1; i >= 0; i--) if (streak() >= MILESTONES[i]) return MILESTONES[i];
    return 0;
  }

  function sharePoster(m) {
    if (!global.CouponShare) return;
    global.CouponShare.openShare({
      link: global.location.origin + '/',
      power: '我在小满券仓连续省钱 ' + m + ' 天',
      sub: '累计省钱力度约 ¥' + num(st.total) + '，扫码一起领',
      t: '先领券再下单更省 · coupon.zangeng.com',
      id: '',
    });
    if (st.milestoneShared.indexOf(m) === -1) { st.milestoneShared.push(m); save(st); }
    if (global.Tracker) global.Tracker.track('challenge_share', { milestone: m, streak: streak(), total: num(st.total) });
  }

  function buildWidget() {
    var wrap = doc.getElementById('chChallengeWrap');
    if (!wrap) return null;
    wrap.innerHTML = '';
    var box = doc.createElement('div');
    box.className = 'ch-bar';
    box.setAttribute('role', 'note');
    var s = streak();
    var nm = nextMilestone();
    var m = milestoneReached();
    var just = (m && st.milestoneShared.indexOf(m) === -1);
    if (just) box.classList.add('is-new');
    box.innerHTML = '<span class="ch-fire" aria-hidden="true">' + (just ? '🎉' : '🔥') + '</span>' +
      '<span class="ch-text">' + (just
        ? ('达成「连续 ' + m + ' 天」省钱成就！累计省钱力度约 ¥' + num(st.total) + '，晒张战报告诉朋友：')
        : ('今日省钱挑战：连续 <b>' + s + '</b> 天 · 累计省钱力度约 <b>¥' + num(st.total) + '</b>' +
          (nm ? '，再连续 ' + (nm - s) + ' 天解锁「' + nm + ' 天达人」战报' : '，已是省钱达人！'))) + '</span>';
    if (m && global.CouponShare) {
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'ch-share';
      btn.textContent = just ? ('晒出 ' + m + ' 天战报') : '分享战报';
      btn.addEventListener('click', function () { sharePoster(m); });
      box.appendChild(btn);
    }
    wrap.appendChild(box);
    wrap.hidden = false;
    return box;
  }

  function render() {
    try { buildWidget(); } catch (e) { /* 静默 */ }
  }

  function boot() {
    if (!doc.getElementById('chChallengeWrap')) return; // 仅首页
    try { checkin(); } catch (e) { return; } // localStorage 不可用则整体不启用
    wireTrack();
    render();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);

/* ==== activities.js ==== */
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

