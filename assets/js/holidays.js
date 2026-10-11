/* ==========================================================================
   holidays.js · 大促日历倒数（holidays.html）
   —— 页面档期内容为静态 HTML（SEO 可读），本脚本仅做渐进增强：
   按 data-m/data-d 锚点（或 data-bf=11 月第 4 个周五）计算每年下一次发生日，
   给每条日历项标「还有 N 天」，并把最近的一场高亮 + 顶部横幅倒数。
   静默失败：任何异常只影响增强显示，不报错、不改静态内容。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var DAY_MS = 24 * 60 * 60 * 1000;

  function todayMid() {
    var d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // 锚点日期（month 1-12 / day）在下一次到来（今年剩余或明年）的 Date
  function nextOccurrence(month, day) {
    var t = todayMid();
    var cand = new Date(t.getFullYear(), month - 1, day);
    if (cand < t) cand = new Date(t.getFullYear() + 1, month - 1, day);
    return cand;
  }

  // 11 月第 4 个星期五（黑五每年浮动）
  function fourthFridayNov() {
    var t = todayMid();
    for (var y = t.getFullYear(); y <= t.getFullYear() + 1; y++) {
      var first = new Date(y, 10, 1);
      var offset = (5 - first.getDay() + 7) % 7; // 第一个周五的日偏移
      var fourth = new Date(y, 10, 1 + offset + 21);
      if (fourth >= t) return fourth;
    }
    return null;
  }

  function daysUntil(date) {
    return Math.round((date - todayMid()) / DAY_MS);
  }

  // 大促名取 .hol-name 的首个文本节点（排除力度 tag 与倒数 span）
  function holName(item) {
    var nameEl = item.querySelector('.hol-name');
    if (!nameEl) return '';
    for (var i = 0; i < nameEl.childNodes.length; i++) {
      var n = nameEl.childNodes[i];
      if (n.nodeType === 3 && n.textContent.trim()) return n.textContent.trim();
    }
    return (nameEl.textContent || '').trim();
  }

  function init() {
    var items = doc.querySelectorAll('.hol-item');
    if (!items.length) return;
    var best = null;
    Array.prototype.forEach.call(items, function (item) {
      var date = null;
      if (item.getAttribute('data-bf')) date = fourthFridayNov();
      else {
        var m = Number(item.getAttribute('data-m'));
        var d = Number(item.getAttribute('data-d'));
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) date = nextOccurrence(m, d);
      }
      if (!date) return;
      var days = daysUntil(date);
      var countEl = item.querySelector('[data-count]');
      if (countEl) countEl.textContent = '（还有 ' + days + ' 天）';
      if (!best || days < best.days) best = { item: item, days: days, name: holName(item) };
    });
    if (!best) return;
    best.item.classList.add('is-next');
    var banner = doc.getElementById('holNext');
    if (banner) {
      banner.hidden = false;
      doc.getElementById('holNextName').textContent = best.name;
      doc.getElementById('holNextDays').textContent = ' 还有 ' + best.days + ' 天';
    }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
