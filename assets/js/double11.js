/* ==========================================================================
   double11.js · 双 11 专题倒数（double11.html）
   —— 页面内容为静态 HTML（SEO 可读），本脚本仅做渐进增强：
   按锚点日期（11 月 1 日开门红 / 11 月 11 日高潮日）计算下一次到来的天数，
   填入「距开门红 / 距高潮日」两个倒数 chip；当日显示「就是今天」。
   静默失败：任何异常只影响倒数显示（保持「—」占位），不报错、不改静态内容。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var DAY_MS = 24 * 60 * 60 * 1000;

  function todayMid() {
    var d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // 锚点日期（month 1-12 / day）在下一次到来（今年剩余或明年）的 Date（与 holidays.js 同口径）
  function nextOccurrence(month, day) {
    var t = todayMid();
    var cand = new Date(t.getFullYear(), month - 1, day);
    if (cand < t) cand = new Date(t.getFullYear() + 1, month - 1, day);
    return cand;
  }

  function daysUntil(date) {
    return Math.round((date - todayMid()) / DAY_MS);
  }

  function fill(id, month, day) {
    var el = doc.getElementById(id);
    if (!el) return;
    var days = daysUntil(nextOccurrence(month, day));
    el.textContent = days === 0 ? '就是今天' : ('还有 ' + days + ' 天');
  }

  function init() {
    try {
      fill('d11OpenDays', 11, 1);
      fill('d11PeakDays', 11, 11);
    } catch (e) { /* 静默：倒数仅增强，失败不影响页面 */ }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
