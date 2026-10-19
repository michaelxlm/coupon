/* ==========================================================================
   app.js · 站点交互（主题、移动菜单、表单、复制）
   数据内容由 scripts/build.js 在构建期注入静态 HTML，本文件只负责运行期交互，
   因此禁用 JS 也不会影响页面可读性与 SEO。
   埋点：交互事件统一走 window.Conv.track（conversion.js），自动带来源归因。
   ========================================================================== */

(function (global) {
  'use strict';

  var doc = global.document;
  var THEME_KEY = 'mrx_theme';

  function $(sel, root) { return (root || doc).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || doc).querySelectorAll(sel));
  }

  function toast(message) {
    var el = $('#toast');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      doc.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    global.clearTimeout(el._timer);
    el._timer = global.setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  function readStore(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStore(key, value) {
    try { global.localStorage.setItem(key, value); } catch (e) { /* 忽略 */ }
  }

  /* --------------------------------- 主题（三站统一：键名 mrx_theme，三态 auto / light / dark） --------------------------------- */
  var THEME_LEGACY = ['__theme'];
  var THEME_MODES = ['auto', 'light', 'dark'];
  var THEME_LABEL = { auto: '自动', light: '亮色', dark: '暗色' };
  var THEME_ICON = { auto: '🌗', light: '☀', dark: '🌙' };

  function systemTheme() {
    try {
      if (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
      if (global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    } catch (e) { /* 不支持媒体查询时走兜底 */ }
    var def = doc.documentElement.getAttribute('data-theme-default');
    return def === 'dark' ? 'dark' : 'light';
  }

  function storedPref() {
    try {
      var v = readStore(THEME_KEY);
      if (v === 'auto' || v === 'light' || v === 'dark') return v;
      // 旧键只迁移不回迁
      for (var i = 0; i < THEME_LEGACY.length; i++) {
        var old = readStore(THEME_LEGACY[i]);
        if (old === 'light' || old === 'dark') {
          try { global.localStorage.setItem(THEME_KEY, old); } catch (e) {}
          return old;
        }
      }
    } catch (e) { /* 隐私模式忽略 */ }
    return 'auto';
  }

  function resolveTheme(pref) {
    return pref === 'dark' || pref === 'light' ? pref : systemTheme();
  }

  function applyTheme(actual, mode) {
    doc.documentElement.setAttribute('data-theme', actual);
    var btn = $('#themeToggle');
    if (btn) {
      // 图标反映「模式」而非解析后的主题：三态循环每点一次图标必变，消除 auto→当前主题 的视觉死步（对齐 color-tool 显示模式名）
      var m = THEME_MODES.indexOf(mode) >= 0 ? mode : 'auto';
      var next = THEME_MODES[(THEME_MODES.indexOf(m) + 1) % THEME_MODES.length];
      btn.textContent = THEME_ICON[m];
      btn.setAttribute('data-theme-mode', m);
      btn.setAttribute('aria-label', '当前主题：' + THEME_LABEL[m] + '，点击切换为' + THEME_LABEL[next]);
      btn.setAttribute('title', '当前主题：' + THEME_LABEL[m] + '（点击切换为' + THEME_LABEL[next] + '）');
    }
  }

  function setTheme(pref, persist) {
    var mode = THEME_MODES.indexOf(pref) >= 0 ? pref : 'auto';
    var actual = resolveTheme(mode);
    applyTheme(actual, mode);
    if (persist !== false) writeStore(THEME_KEY, mode);
    if (global.Conv) global.Conv.track('theme_switch', { theme: mode });
  }

  function initTheme() {
    var pref = storedPref();
    applyTheme(resolveTheme(pref), pref);
    var btn = $('#themeToggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var cur = storedPref();
      var next = THEME_MODES[(THEME_MODES.indexOf(cur) + 1) % THEME_MODES.length];
      setTheme(next);
    });
    // auto 偏好下跟随系统实时生效
    try {
      var mq = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)');
      if (mq && mq.addEventListener) {
        mq.addEventListener('change', function () {
          if (storedPref() !== 'auto') return;
          applyTheme(systemTheme(), 'auto');
        });
      }
    } catch (e) { /* 老浏览器忽略 */ }
  }

  /* ------------------------------- 移动端菜单 ------------------------------- */
  function initNav() {
    var toggle = $('#navToggle');
    var nav = $('#primaryNav');
    if (!toggle || !nav) return;
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'A') {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* -------------------------------- 复制文本 -------------------------------- */
  function copyText(text) {
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      return global.navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = doc.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        doc.body.appendChild(ta);
        ta.select();
        doc.execCommand('copy');
        doc.body.removeChild(ta);
        resolve();
      } catch (e) { reject(e); }
    });
  }

  function initCopy() {
    $$('[data-copy]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        var text = el.getAttribute('data-copy') || '';
        copyText(text).then(function () {
          toast('已复制：' + text);
          if (global.Conv) global.Conv.track('copy', { type: el.getAttribute('data-copy-type') || 'text' });
        }).catch(function () {
          toast('复制失败，请手动选中：' + text);
        });
      });
    });
  }

  /* -------------------------------- 联系表单 -------------------------------- */
  /**
   * 静态站没有后端：提交后拼 mailto 交给用户自己的邮件客户端发送，
   * 同时上报 form_submit（主转化事件）。后续接了后端，把 openMail 换成 fetch 即可。
   */
  function initForm() {
    var form = $('#contactForm');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = (form.elements.name && form.elements.name.value || '').trim();
      var company = (form.elements.company && form.elements.company.value || '').trim();
      var contact = (form.elements.contact && form.elements.contact.value || '').trim();
      var topic = (form.elements.topic && form.elements.topic.value || '').trim();
      var message = (form.elements.message && form.elements.message.value || '').trim();

      if (!name) { toast('请填写你的称呼'); return; }
      if (!contact) { toast('请填写邮箱或手机号，方便我联系你'); return; }

      if (global.Conv) global.Conv.track('form_submit', { topic: topic || '未选择' });

      var email = form.getAttribute('data-email') || '';
      if (!email) {
        toast('已收到，我们会尽快联系你');
        form.reset();
        return;
      }

      var subject = '[实测手记] ' + (topic || '咨询') + ' · ' + name + (company ? '（' + company + '）' : '');
      var body = [
        '称呼：' + name,
        '公司：' + (company || '-'),
        '联系方式：' + contact,
        '咨询类型：' + (topic || '-'),
        '',
        '留言：',
        message || '-',
      ].join('\n');

      global.location.href = 'mailto:' + email +
        '?subject=' + encodeURIComponent(subject) +
        '&body=' + encodeURIComponent(body);

      toast('已打开邮件客户端，发送后我会回信');
      form.reset();
    });
  }

  /* ------------------------------ 回到顶部 ------------------------------ */
  // 滚动超过一屏后右下角浮现；纯 DOM 派生，无需页面预埋容器
  function initBackTop() {
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'cp-back-top';
    btn.hidden = true;
    btn.setAttribute('aria-label', '回到顶部');
    btn.textContent = '↑';
    doc.body.appendChild(btn);
    btn.addEventListener('click', function () {
      try { global.scrollTo({ top: 0, behavior: 'smooth' }); }
      catch (e) { doc.documentElement.scrollTop = 0; }
    });
    var ticking = false;
    global.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      global.setTimeout(function () {
        ticking = false;
        btn.hidden = (global.scrollY || doc.documentElement.scrollTop || 0) < 600;
      }, 100);
    }, { passive: true });
  }

  /* --------------------------- AB 实验客户端分桶（M11） --------------------------- */
  // 由匿名访客 ID 哈希决定桶（A/B），上报 exp_assign；券卡埋点带 bucket 供回收分析
  function initExp() {
    if (!global.Tracker) return;
    var vid = global.Tracker.visitorId();
    if (!vid) return;
    var h = 0;
    for (var i = 0; i < vid.length; i++) h = (h * 31 + vid.charCodeAt(i)) | 0;
    var bucket = (Math.abs(h) % 100) < 50 ? 'A' : 'B';
    global.__exp = { name: 'card_style_2026', bucket: bucket };
    global.Tracker.track('exp_assign', { exp: 'card_style_2026', bucket: bucket });
  }

  /* ----------------------------- PWA 注册（M5a） ----------------------------- */
  function initPWA() {
    if ('serviceWorker' in global.navigator) {
      global.addEventListener('load', function () {
        global.navigator.serviceWorker.register('/sw.js').catch(function () { /* 注册失败不影响页面 */ });
      });
    }
  }

  /* ----------------------- Web Push 订阅 + 引导（M5b · W5） -----------------------
     —— 改造：不再页面加载即静默 requestPermission（浏览器会替用户默默拒绝）；
        改为底部引导条，用户主动点击后才走授权→订阅→上报链路；
        iOS（PushManager 不可用）引导「添加到主屏幕」（iOS 16.4+ 主屏 PWA 支持通知）；
        已授权用户仍静默刷新订阅。暴露 window.CouponPush 供 /my-alerts.html 复用。 */
  var PUSH_API = 'https://api.xuyiheng.com/api/v1/front/coupon';
  var PUSH_DISMISS_KEY = 'coupon_push_dismiss';

  function pushMainUrl() {
    return (global.location && global.location.hostname) || 'coupon.zangeng.com';
  }

  function pushSupported() {
    return ('serviceWorker' in global.navigator) && ('PushManager' in global) && ('Notification' in global);
  }

  function isIOS() {
    var ua = String(global.navigator.userAgent || '');
    return /iP(hone|ad|od)/.test(ua) || (ua.indexOf('Macintosh') !== -1 && 'ontouchend' in doc);
  }

  function isStandalone() {
    return (global.navigator.standalone === true) ||
      (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches);
  }

  // 已有授权→静默完成订阅上报（授权由 enablePush 的引导链路触发，不在这里弹窗）
  function ensureSubscription(dev, cb) {
    global.navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      var doSub = function (raw) {
        // 携带 mainUrl 过后端 sourceGuard 来源守卫（与 /coupon/jd/* 同一口径）
        global.fetch(PUSH_API + '/push/subscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: dev, subscription: raw, mainUrl: pushMainUrl() }),
        }).then(function () { if (cb) cb(null); }).catch(function (e) { if (cb) cb(e); });
      };
      if (sub) { doSub(sub.toJSON ? sub.toJSON() : sub); return null; }
      return global.fetch(PUSH_API + '/push/vapid?mainUrl=' + encodeURIComponent(pushMainUrl()), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var pk = j && j.data && j.data.publicKey;
          if (!pk) { if (cb) cb(new Error('no-vapid')); return null; } // 未配置 VAPID：仍可用「我的降价提醒」列表
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pk })
            .then(function (s) { doSub(s.toJSON ? s.toJSON() : s); });
        });
    }).catch(function (e) { if (cb) cb(e); });
  }

  // 主动开启：请求权限 → 订阅 → 上报；回调 (err, state)
  function enablePush(cb) {
    if (!pushSupported()) { if (cb) cb(null, 'unsupported'); return; }
    if (!global.Tracker) { if (cb) cb(null, 'no-tracker'); return; }
    var dev = global.Tracker.visitorId();
    if (!dev) { if (cb) cb(null, 'no-device'); return; }
    if (global.Notification.permission === 'granted') { ensureSubscription(dev, function (e) { if (cb) cb(e, 'granted'); }); return; }
    if (global.Notification.permission === 'denied') { if (cb) cb(null, 'denied'); return; }
    global.Notification.requestPermission().then(function (perm) {
      if (perm === 'granted') { ensureSubscription(dev, function (e) { if (cb) cb(e, 'granted'); }); }
      else if (cb) cb(null, perm);
    }).catch(function () { if (cb) cb(null, 'error'); });
  }

  // 背景静默链路：仅对已授权用户刷新订阅（不弹窗）
  function initPush() {
    if (!pushSupported() || !global.Tracker) return;
    if (global.Notification.permission !== 'granted') return;
    var dev = global.Tracker.visitorId();
    if (!dev) return;
    global.addEventListener('load', function () {
      ensureSubscription(dev, null);
    });
  }

  // 底部引导条：未授权时显著引导（计划 W5）；7 天内点过「以后再说」则不打扰
  function initPushGuide() {
    try {
      if (doc.body && doc.body.getAttribute('data-page') === 'my-alerts') return; // 提醒中心页自带授权卡
      var dismissedAt = Number(global.localStorage.getItem(PUSH_DISMISS_KEY) || 0);
      if (dismissedAt && Date.now() - dismissedAt < 7 * 86400000) return;
      var iosNoPush = isIOS() && !pushSupported() && !isStandalone();
      var desktopAsk = pushSupported() && global.Notification.permission === 'default';
      if (!iosNoPush && !desktopAsk) return;

      var bar = doc.createElement('div');
      bar.className = 'pg-banner';
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', '降价提醒开通引导');
      var txt = doc.createElement('span');
      txt.className = 'pg-text';
      txt.textContent = iosNoPush
        ? '📲 iPhone 用户：用 Safari「添加到主屏幕」后，可从主屏图标开启降价推送'
        : '🔔 开启浏览器通知，订阅的券降价 / 加码第一时间提醒你（匿名设备，不注册账号）';
      bar.appendChild(txt);
      function dismissBar() {
        try { global.localStorage.setItem(PUSH_DISMISS_KEY, String(Date.now())); } catch (e) { /* 忽略 */ }
        bar.remove();
      }
      if (desktopAsk) {
        var ok = doc.createElement('button');
        ok.type = 'button'; ok.className = 'pg-btn pg-btn--go'; ok.textContent = '开启通知';
        ok.addEventListener('click', function () {
          enablePush(function (err, state) {
            if (state === 'granted') { toast('已开启降价提醒推送'); bar.remove(); }
            else if (state === 'denied') { toast('浏览器已拦截通知，可在地址栏设置里恢复'); dismissBar(); }
            else dismissBar();
          });
        });
        bar.appendChild(ok);
      } else {
        var go = doc.createElement('a');
        go.className = 'pg-btn pg-btn--go'; go.href = '/my-alerts.html#ios'; go.textContent = '查看教程';
        bar.appendChild(go);
      }
      var later = doc.createElement('button');
      later.type = 'button'; later.className = 'pg-btn pg-btn--later'; later.textContent = '以后再说';
      later.addEventListener('click', dismissBar);
      bar.appendChild(later);
      doc.body.appendChild(bar);
      if (global.Tracker) global.Tracker.track('push_guide_view', { ios: iosNoPush ? 1 : 0 });
    } catch (e) { /* 引导失败不影响页面 */ }
  }

  global.CouponPush = {
    enable: enablePush, supported: pushSupported, isIOS: isIOS, isStandalone: isStandalone,
    permission: function () { return pushSupported() ? global.Notification.permission : 'unsupported'; },
  };

  /* --------------------------------- 启动 --------------------------------- */
  function boot() {
    initTheme();
    initNav();
    initCopy();
    initForm();
    initBackTop();
    initExp();
    initPWA();
    initPush();
    initPushGuide();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
