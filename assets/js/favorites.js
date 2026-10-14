/* ==========================================================================
   favorites.js · 我的收藏 / 最近看过页渲染（favorites.html）
   —— 数据全部来自 store.js（localStorage），本脚本只做渲染与删除/清空交互。
   静默失败：store.js 未加载或存储不可用时展示空态，不报错。
   券卡操作：收藏卡可「去凑单」（带参数跳计算器）与「取消」；看过卡可「收藏」与「删除」。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var API_BASE = 'https://api.xuyiheng.com';

  function $(id) { return doc.getElementById(id); }

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function safeUrl(u) {
    if (typeof u !== 'string') return '';
    var v = u.trim();
    if (/^https?:\/\//i.test(v)) return v;
    if (/^\/\//.test(v)) return 'https:' + v;
    return '';
  }

  // 由本地快照重建券卡（与列表页 buildCard 同构：cp-name / cp-off / cp-final）
  function buildCard(item) {
    var a = el('a', 'cp-card');
    var link = safeUrl(item.url);
    a.href = link || '#';
    if (link) { a.target = '_blank'; a.setAttribute('rel', 'sponsored noopener'); }
    else { a.classList.add('is-dead'); a.setAttribute('aria-disabled', 'true'); }
    if (item.id) a.setAttribute('data-case', 'coupon:' + item.id);
    if (item.img) {
      var img = el('img');
      img.alt = item.t || '';
      img.width = 300; img.height = 300;
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      img.setAttribute('referrerpolicy', 'no-referrer');
      img.onerror = function () { img.parentNode && img.parentNode.removeChild(img); };
      img.src = item.img;
      a.appendChild(img);
    }
    a.appendChild(el('span', 'cp-name', item.t || '（已被清理的券）'));
    var price = el('div', 'cp-price');
    var off = Number(item.off) || 0;
    var quota = Number(item.quota) || 0;
    if (off > 0) price.appendChild(el('span', 'cp-off', quota > 0 ? ('满' + quota + '减' + off) : ('券 ¥' + off)));
    var finalPrice = Number(item.price) || 0;
    if (finalPrice > 0) price.appendChild(el('span', 'cp-final', '¥' + finalPrice));
    a.appendChild(price);
    return a;
  }

  function calcLink(item) {
    var qs = [];
    if (item.price) qs.push('price=' + encodeURIComponent(item.price));
    if (item.quota) qs.push('quota=' + encodeURIComponent(item.quota));
    if (item.off) qs.push('off=' + encodeURIComponent(item.off));
    return '/calculator.html' + (qs.length ? '?' + qs.join('&') : '');
  }

  // cell = 券卡 + 操作行；actions 为 [node]，追加在卡片下方（不落在 <a> 内）
  function buildCell(item, actions) {
    var cell = el('div', 'cp-cell');
    cell.setAttribute('role', 'listitem');
    cell.appendChild(buildCard(item));
    var row = el('div', 'cp-card-actions');
    actions.forEach(function (n) { row.appendChild(n); });
    cell.appendChild(row);
    return cell;
  }

  function renderGrid(gridEl, emptyEl, countEl, list, mode) {
    gridEl.innerHTML = '';
    var has = list.length > 0;
    emptyEl.hidden = has;
    gridEl.hidden = !has;
    if (countEl) countEl.textContent = has ? ('共 ' + list.length + ' 条') : '';
    if (mode === 'fav' && global.CouponStore) {
      list.forEach(function (item) {
        var calc = el('a', 'cp-mini-btn', '去凑单');
        calc.href = calcLink(item);
        calc.setAttribute('aria-label', '用凑单计算器计算该券');
        var rm = el('button', 'cp-mini-btn is-danger', '取消收藏');
        rm.type = 'button';
        rm.addEventListener('click', function () {
          global.CouponStore.removeFav(item.id);
          if (global.Conv) global.Conv.track('fav_remove', { coupon_id: item.id });
          refresh();
        });
        gridEl.appendChild(buildCell(item, [ calc, rm ]));
      });
    } else {
      list.forEach(function (item) {
        var fav = el('button', 'cp-mini-btn', global.CouponStore && global.CouponStore.isFav(item.id) ? '已收藏' : '收藏');
        fav.type = 'button';
        fav.addEventListener('click', function () {
          var on = global.CouponStore.toggleFav(item);
          fav.textContent = on ? '已收藏' : '收藏';
          if (global.Conv) global.Conv.track('fav_toggle', { coupon_id: item.id, on: on ? 1 : 0 });
        });
        var del = el('button', 'cp-mini-btn is-danger', '删除');
        del.type = 'button';
        del.addEventListener('click', function () {
          global.CouponStore.removeRecent(item.id);
          refresh();
        });
        gridEl.appendChild(buildCell(item, [ fav, del ]));
      });
    }
  }

  // 我的降价提醒（M2）：后端按 deviceId 返回订阅与当前力度对比
  function buildAlertCard(item) {
    var a = el('a', 'cp-card');
    a.href = '#';
    var cur = item.current || item.baseline || {};
    var price = Number(cur.price) || 0;
    var off = Number(cur.couponDiscount) || 0;
    var quota = Number(cur.couponQuota) || 0;
    a.appendChild(el('span', 'cp-name', item.title || '优惠券'));
    var p = el('div', 'cp-price');
    if (off > 0) p.appendChild(el('span', 'cp-off', quota > 0 ? ('满' + quota + '减' + off) : ('券 ¥' + off)));
    if (price > 0) p.appendChild(el('span', 'cp-final', '¥' + price));
    var status = '';
    if (!item.current) status = '已失效';
    else if ((Number(item.current.couponDiscount) || 0) > (Number(item.baseline.couponDiscount) || 0)) status = '券力提升';
    else if ((Number(item.current.price) || 0) < (Number(item.baseline.price) || 0)) status = '到手价下降';
    if (status) p.appendChild(el('span', 'cp-expire is-hot', status));
    a.appendChild(p);
    return a;
  }

  function loadAlerts() {
    var grid = $('alertGrid');
    if (!grid) return;
    var empty = $('alertEmpty');
    var count = $('alertCount');
    var dev = global.Tracker && global.Tracker.visitorId ? global.Tracker.visitorId() : '';
    if (!dev) { if (empty) empty.hidden = false; grid.hidden = true; return; }
    var url = API_BASE + '/api/v1/front/coupon/alert/list?deviceId=' + encodeURIComponent(dev);
    global.fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var list = (j && j.data && j.data.list) || [];
      grid.innerHTML = '';
      var has = list.length > 0;
      if (empty) empty.hidden = has;
      grid.hidden = !has;
      if (count) count.textContent = has ? ('共 ' + list.length + ' 条') : '';
      list.forEach(function (it) { grid.appendChild(buildAlertCard(it)); });
    }).catch(function () { if (empty) empty.hidden = false; grid.hidden = true; });
  }

  function refresh() {
    if (!global.CouponStore) return;
    var favList = global.CouponStore.favs();
    var recentList = global.CouponStore.recent();
    renderGrid($('favGrid'), $('favEmpty'), $('favCount'), favList, 'fav');
    renderGrid($('recentGrid'), $('recentEmpty'), $('recentCount'), recentList, 'recent');
    $('favClear').hidden = !favList.length;
    $('recentClear').hidden = !recentList.length;
  }

  function init() {
    if (!$('favGrid') || !global.CouponStore) return;
    $('favClear').addEventListener('click', function () {
      if (!global.confirm('确定清空全部收藏吗？此操作不可恢复。')) return;
      global.CouponStore.clearFavs();
      refresh();
    });
    // 导出收藏为 JSON 文件（本地备份 / 跨设备迁移）
    var exportBtn = $('favExport');
    if (exportBtn) exportBtn.addEventListener('click', function () {
      var data = global.CouponStore.exportFavs();
      var blob = new global.Blob([data], { type: 'application/json' });
      var url = global.URL.createObjectURL(blob);
      var a = doc.createElement('a');
      a.href = url;
      a.download = 'coupon-favs.json';
      doc.body.appendChild(a);
      a.click();
      doc.body.removeChild(a);
      global.URL.revokeObjectURL(url);
      if (global.Conv) global.Conv.track('fav_export', {});
    });
    // 导入收藏：选择 JSON 文件后按 id 合并去重
    var importBtn = $('favImport');
    var importFile = $('favImportFile');
    if (importBtn && importFile) {
      importBtn.addEventListener('click', function () { importFile.click(); });
      importFile.addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var reader = new global.FileReader();
        reader.onload = function () {
          var res = global.CouponStore.importFavs(reader.result);
          if (global.Conv) global.Conv.track('fav_import', { ok: res.ok ? 1 : 0 });
          global.alert(res.ok ? ('导入完成：新增 ' + res.added + ' 条，现有 ' + res.total + ' 条。') : ('导入失败：' + res.msg));
          refresh();
          e.target.value = '';
        };
        reader.onerror = function () { global.alert('读取文件失败，请重试。'); };
        reader.readAsText(file);
      });
    }
    $('recentClear').addEventListener('click', function () {
      if (!global.confirm('确定清空最近看过吗？')) return;
      global.CouponStore.clearRecent();
      refresh();
    });
    refresh();
    loadAlerts();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
