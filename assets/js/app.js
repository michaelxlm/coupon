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

  function applyTheme(actual) {
    doc.documentElement.setAttribute('data-theme', actual);
    var btn = $('#themeToggle');
    if (btn) {
      btn.textContent = actual === 'dark' ? '☀' : '🌙';
      btn.setAttribute('aria-label', actual === 'dark' ? '切换到浅色' : '切换到深色');
    }
  }

  function setTheme(pref, persist) {
    var mode = THEME_MODES.indexOf(pref) >= 0 ? pref : 'auto';
    var actual = resolveTheme(mode);
    applyTheme(actual);
    if (persist !== false) writeStore(THEME_KEY, mode);
    if (global.Conv) global.Conv.track('theme_switch', { theme: mode });
  }

  function initTheme() {
    var pref = storedPref();
    applyTheme(resolveTheme(pref));
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
          applyTheme(systemTheme());
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

  /* --------------------------------- 启动 --------------------------------- */
  function boot() {
    initTheme();
    initNav();
    initCopy();
    initForm();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
