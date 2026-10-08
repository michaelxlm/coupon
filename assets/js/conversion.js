/* ==========================================================================
   conversion.js · 转化与来源归因层
   依赖：tracker.js（window.Tracker）
   口径表：data/conversion.json（改埋点必须同步改口径表）

   职责分工：
     - tracker.js 负责「怎么发」：SDK 自动 PV、[data-track] 点击委托、批量上报
     - 本文件负责「发什么」：来源归因、暴露类事件（案例进入视口）、
       滚动深度、FAQ 展开、站外点击，并为每个事件带上 src 归因
     - 中台侧按 visitorId + sessionId 把 session_start 的 src 关联到同会话其它事件

   对外：window.Conv.track(event, props) —— 业务代码统一走这里手动打点
   调试：页面加 ?conversion=1 时，控制台打印归因与本地聚合计数
   ========================================================================== */

(function (global) {
  'use strict';

  var doc = global.document;
  if (!doc) return;

  var STORE_KEY = '__cv_src';
  var SESSION_FLAG = '__cv_started';
  var debug = /[?&]conversion=1/.test(global.location.search);
  var localCount = {};

  var ATTR_KEYS = ['src', 'utm_source', 'utm_medium', 'utm_campaign', 'ref', 'from'];

  function readStore(key, store) {
    try { return (store || global.localStorage).getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, value, store) {
    try { (store || global.localStorage).setItem(key, value); } catch (e) { /* 忽略 */ }
  }

  function param(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(global.location.search);
      return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
    } catch (e) { return ''; }
  }

  /** 解析来源：显式参数 > 首次来源（持久化）> referrer 域名 > direct */
  function resolveSource() {
    var explicit = '';
    for (var i = 0; i < ATTR_KEYS.length; i++) {
      var v = param(ATTR_KEYS[i]);
      if (v) { explicit = v; break; }
    }

    var saved = readStore(STORE_KEY);
    if (explicit) {
      if (explicit !== saved) writeStore(STORE_KEY, explicit);
      return { src: explicit, firstTouch: explicit !== saved };
    }
    if (saved) return { src: saved, firstTouch: false };

    var ref = '';
    try { ref = doc.referrer || ''; } catch (e) { ref = ''; }
    if (ref) {
      var m = /^https?:\/\/([^/]+)/i.exec(ref);
      if (m && m[1].replace(/^www\./, '') !== global.location.host.replace(/^www\./, '')) {
        return { src: 'ref:' + m[1], firstTouch: false };
      }
    }
    return { src: 'direct', firstTouch: false };
  }

  var attrs = {
    src: 'direct',
    utm_source: param('utm_source'),
    utm_medium: param('utm_medium'),
    utm_campaign: param('utm_campaign'),
    ref: param('ref') || param('from'),
  };

  function track(event, props) {
    localCount[event] = (localCount[event] || 0) + 1;
    var merged = { src: attrs.src };
    if (attrs.utm_source) merged.utm_source = attrs.utm_source;
    if (attrs.utm_medium) merged.utm_medium = attrs.utm_medium;
    if (attrs.utm_campaign) merged.utm_campaign = attrs.utm_campaign;
    if (props) {
      for (var k in props) {
        if (Object.prototype.hasOwnProperty.call(props, k)) merged[k] = props[k];
      }
    }
    if (global.Tracker && global.Tracker.track) {
      return global.Tracker.track(event, merged);
    }
    return null;
  }

  /** 会话建立：每会话只报一次，带完整归因 — 中台据此给同会话事件补 src */
  function trackSessionStart() {
    var s = resolveSource();
    attrs.src = s.src;
    var started = false;
    try { started = global.sessionStorage.getItem(SESSION_FLAG) === '1'; } catch (e) { started = false; }
    if (started) return;
    try { global.sessionStorage.setItem(SESSION_FLAG, '1'); } catch (e) { /* 忽略 */ }
    track('session_start', {
      first_touch: s.firstTouch ? 1 : 0,
      landing: global.location.pathname || '/',
    });
  }

  /** 站外点击：与 cta_click（站内主 CTA）分开记，不计入主转化 */
  function bindOutbound() {
    doc.addEventListener('click', function (e) {
      var el = e.target;
      for (var i = 0; el && i < 5; i++) {
        if (el.tagName === 'A') break;
        el = el.parentNode;
      }
      if (!el || el.tagName !== 'A') return;
      var href = el.getAttribute('href') || '';
      if (!/^https?:/i.test(href)) return; // 站内相对路径不算站外
      try {
        if (new global.URL(href).host === global.location.host) return;
      } catch (_) { /* 解析失败照常上报 */ }
      if (el.getAttribute('data-track')) return; // 已有显式埋点，不重复计数
      track('outbound_click', { target: href.slice(0, 120) });
    }, false);
  }

  /** FAQ 展开：高频问题 = 内容缺口 */
  function bindFaq() {
    doc.addEventListener('toggle', function (e) {
      var el = e.target;
      if (!el || el.tagName !== 'DETAILS' || !el.open) return;
      var q = '';
      var sum = el.querySelector('summary');
      if (sum) q = (sum.textContent || '').trim().slice(0, 40);
      track('faq_open', { q: q });
    }, true);
  }

  /** 滚动深度：25 / 50 / 75 / 100，每档每会话只报一次 */
  function bindScrollDepth() {
    var marks = [25, 50, 75, 100];
    var sent = {};
    var ticking = false;
    function check() {
      ticking = false;
      var docEl = doc.documentElement;
      var scrollable = docEl.scrollHeight - global.innerHeight;
      if (scrollable <= 0) return;
      var pct = Math.round((global.scrollY || docEl.scrollTop) / scrollable * 100);
      for (var i = 0; i < marks.length; i++) {
        if (pct >= marks[i] && !sent[marks[i]]) {
          sent[marks[i]] = 1;
          track('scroll_depth', { depth: marks[i] });
        }
      }
    }
    global.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      global.setTimeout(check, 200);
    }, { passive: true });
    check();
  }

  /** 案例卡片曝光：进入视口 ≥50% 且停留 1s，每卡每会话只报一次 */
  function bindCaseView() {
    if (!global.IntersectionObserver) return;
    var seen = {};
    var timers = {};
    var io = new global.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var id = entry.target.getAttribute('data-case') || '';
        if (!id || seen[id]) return;
        if (entry.isIntersecting) {
          timers[id] = global.setTimeout(function () {
            seen[id] = 1;
            track('case_view', { case: id });
          }, 1000);
        } else if (timers[id]) {
          global.clearTimeout(timers[id]);
          timers[id] = null;
        }
      });
    }, { threshold: 0.5 });

    var nodes = doc.querySelectorAll('[data-case]');
    for (var i = 0; i < nodes.length; i++) io.observe(nodes[i]);
  }

  function boot() {
    if (!global.Tracker) return; // SDK 被拦截时不报错，页面照常可用
    trackSessionStart();
    bindOutbound();
    bindFaq();
    bindScrollDepth();
    bindCaseView();
    if (debug && global.console) {
      global.console.log('[Conversion] attrs:', attrs, 'localCount:', localCount);
    }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.Conv = {
    track: track,
    attrs: attrs,
    count: localCount,
  };
})(window);
