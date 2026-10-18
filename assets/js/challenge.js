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
