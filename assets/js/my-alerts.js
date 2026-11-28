/* ==========================================================================
   my-alerts.js · 降价提醒中心（W5 · /my-alerts.html）
   —— 本地订阅清单（CouponStore.alerts）+ 当前力度对比：
     批量 fetch /coupon/jd/priceBatch 取每券最近快照，与订阅基线比较，
     到手价下降或券面额提升 → 卡片高亮 + 「已降/加码」标记。
   —— 到期/大额提醒：走公众号（服务号）网页授权订阅（web-push / 带参小程序码均已退役），
     页面顶部渲染「关注公众号开启提醒」引导卡；订阅动作在券卡/引导卡点击时由 CouponStore 发起。
   —— 详情页承接：详情键统一 _id（告警快照 did 字段）→ /p/<_id>.html；命中静态预渲染白名单
     或已捕获 _id 即给链接（nginx 动态回退壳保证同 URL 恒不 404）。
   —— 静默失败：任何接口异常只退回基线展示，不报错。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var API_BASE = 'https://api.xuyiheng.com';
  var MAIN_URL = 'coupon.zangeng.com';

  function $(id) { return doc.getElementById(id); }
  function num(v) { return (Math.round(Number(v) * 100) / 100) || 0; }

  /* ------------------------------ 订阅清单 ------------------------------ */
  var detailIdSet = null;

  function loadDetailIds(cb) {
    fetch('/data/coupon-snapshot.json', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (j) { detailIdSet = {}; (j && j.detailIds ? j.detailIds : []).forEach(function (x) { detailIdSet[String(x)] = 1; }); cb(); })
      .catch(function () { detailIdSet = {}; cb(); });
  }

  function loadCurrent(alerts, cb) {
    var ids = alerts.map(function (a) { return String(a.id); }).slice(0, 60);
    if (!ids.length) return cb({});
    var url = API_BASE + '/api/v1/front/coupon/jd/priceBatch?ids=' + encodeURIComponent(ids.join(',')) +
      '&limit=30&mainUrl=' + encodeURIComponent(MAIN_URL);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 12000);
    fetch(url, { signal: ctrl.signal })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { clearTimeout(timer); cb((j && j.data && j.data.map) || {}); })
      .catch(function () { clearTimeout(timer); cb({}); });
  }

  function buildCard(a, series) {
    var wrap = doc.createElement('div');
    wrap.className = 'cp-cell ma-cell';
    var base = a.baseline || { price: a.price, couponDiscount: a.off, quota: a.quota };
    var cur = series && series.length ? series[series.length - 1] : null;
    var hitPrice = cur && num(base.price) > 0 && num(cur.price) > 0 && num(cur.price) < num(base.price);
    var hitOff = cur && num(cur.couponDiscount) > num(base.couponDiscount || 0);
    if (hitPrice || hitOff) wrap.classList.add('is-hit');

    var img = doc.createElement('div');
    img.className = 'ma-img';
    if (a.img) { var i = doc.createElement('img'); i.src = a.img; i.alt = a.t || ''; i.loading = 'lazy'; i.referrerPolicy = 'no-referrer'; img.appendChild(i); }
    wrap.appendChild(img);

    var bodyEl = doc.createElement('div');
    bodyEl.className = 'ma-body';
    var t = doc.createElement('div');
    t.className = 'ma-title';
    t.textContent = a.t || '优惠券';
    bodyEl.appendChild(t);

    var cmp = doc.createElement('div');
    cmp.className = 'ma-cmp';
    var baseTxt = '订阅时：' + ((base.couponDiscount || a.off) > 0 ? ('满' + (base.quota || a.quota || 0) + '减' + (base.couponDiscount || a.off) + ' ') : '') + '到手 ¥' + num(base.price || a.price);
    cmp.appendChild(doc.createElement('span')).textContent = baseTxt;
    cmp.appendChild(doc.createElement('br'));
    if (cur) {
      cmp.lastChild.textContent = '当前：' + (num(cur.couponDiscount) > 0 ? ('减' + num(cur.couponDiscount) + ' ') : '') + '到手 ¥' + num(cur.price);
      if (hitPrice) { var b1 = doc.createElement('b'); b1.className = 'ma-hit-txt'; b1.textContent = ' ↓已降 ¥' + num(base.price - cur.price); cmp.lastChild.appendChild(b1); }
      if (hitOff) { var b2 = doc.createElement('b'); b2.className = 'ma-hit-txt'; b2.textContent = ' ↑券加码 ¥' + num(cur.couponDiscount - (base.couponDiscount || 0)); cmp.lastChild.appendChild(b2); }
    } else {
      cmp.lastChild.textContent = '当前：暂无新快照（每日累计，降价后会显示在这里）';
    }
    bodyEl.appendChild(cmp);

    var row = doc.createElement('div');
    row.className = 'ma-actions';
    if (a.url) {
      var claim = doc.createElement('a');
      claim.className = 'btn btn-sm ma-claim'; claim.href = a.url; claim.target = '_blank'; claim.rel = 'sponsored noopener';
      claim.textContent = '去领券';
      claim.setAttribute('data-track', 'coupon_click');
      claim.setAttribute('data-case', 'coupon:' + a.id);
      row.appendChild(claim);
    }
    // 详情键统一 _id：告警快照带 did（新）优先，兼容旧条目回落 snapshot detailIds 白名单（现为 _id 集）
    var detId = String(a.did || '');
    if (detId || (detailIdSet && detailIdSet[String(a.id)])) {
      var hrefId = detId || String(a.id);
      var det = doc.createElement('a');
      det.className = 'btn btn-sm btn-ghost'; det.href = '/p/' + encodeURIComponent(hrefId) + '.html'; det.textContent = '详情';
      row.appendChild(det);
    }
    if (global.CouponShare && a.id) {
      var share = doc.createElement('button');
      share.type = 'button'; share.className = 'btn btn-sm btn-ghost'; share.textContent = '分享';
      share.addEventListener('click', function () {
        global.CouponShare.openShare({ id: a.id, t: a.t, img: a.img, url: a.url, price: num(base.price || a.price), quota: num(base.quota || a.quota), off: num(base.couponDiscount || a.off) });
      });
      row.appendChild(share);
    }
    var off = doc.createElement('button');
    off.type = 'button'; off.className = 'btn btn-sm btn-ghost ma-unsub'; off.textContent = '取消提醒';
    off.addEventListener('click', function () {
      global.CouponStore.toggleAlert({ id: a.id, t: a.t, img: a.img, url: a.url, price: num(base.price || a.price), quota: num(base.quota || a.quota), off: num(base.couponDiscount || a.off) });
      render();
    });
    row.appendChild(off);
    bodyEl.appendChild(row);

    wrap.appendChild(bodyEl);
    return wrap;
  }

  function render() {
    var grid = $('alertGrid'), empty = $('alertEmpty'), count = $('alertCount');
    if (!grid || !global.CouponStore) return;
    var alerts = global.CouponStore.alerts();
    if (count) count.textContent = alerts.length ? ('共 ' + alerts.length + ' 条') : '';
    if (!alerts.length) { grid.innerHTML = ''; if (empty) empty.hidden = false; return; }
    if (empty) empty.hidden = true;
    loadCurrent(alerts, function (map) {
      grid.innerHTML = '';
      alerts.forEach(function (a) { grid.appendChild(buildCard(a, map[String(a.id)])); });
    });
  }

  /* ------------------------------ 本机订阅迁移 ------------------------------ */
  var transferText = '', transferPreview = null;

  function resetTransferPreview() {
    transferText = '';
    transferPreview = null;
    var confirm = $('alertImportConfirm');
    if (confirm) confirm.hidden = true;
  }

  function transferStatus(text) {
    var status = $('alertTransferStatus');
    if (status) status.textContent = text;
  }

  function initTransfer() {
    var CS = global.CouponStore;
    if (!CS || !CS.previewAlerts || !CS.importAlerts) return;
    var file = $('alertImportFile'), previewBtn = $('alertPreview'), mode = $('alertImportMode');
    var exportBtn = $('alertExport'), confirmBtn = $('alertImportConfirm');
    if (exportBtn) exportBtn.addEventListener('click', function () {
      try {
        var blob = new Blob([ CS.exportAlerts() ], { type: 'application/json;charset=utf-8' });
        var url = URL.createObjectURL(blob), link = doc.createElement('a');
        link.href = url;
        link.download = 'coupon-price-alerts-' + new Date().toISOString().slice(0, 10) + '.json';
        doc.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        transferStatus('备份已生成，请妥善保存；文件包含订阅券的名称、图片和链接。');
      } catch (e) { transferStatus('导出失败，请检查浏览器下载权限。'); }
    });
    if (file) file.addEventListener('change', function () {
      resetTransferPreview();
      transferStatus('');
      if (!file.files || !file.files.length) { if (previewBtn) previewBtn.disabled = true; return; }
      if (file.files[0].size > 512 * 1024) { transferStatus('文件超过 512KB，未读取。'); if (previewBtn) previewBtn.disabled = true; return; }
      var reader = new FileReader();
      reader.onload = function () {
        transferText = String(reader.result || '');
        if (previewBtn) previewBtn.disabled = false;
        transferStatus('文件已读取，请点击「预览导入」；当前订阅清单尚未修改。');
      };
      reader.onerror = function () { transferStatus('文件读取失败，请重新选择。'); };
      reader.readAsText(file.files[0]);
    });
    if (mode) mode.addEventListener('change', resetTransferPreview);
    if (previewBtn) previewBtn.addEventListener('click', function () {
      transferPreview = CS.previewAlerts(transferText);
      if (!transferPreview.ok) { transferStatus(transferPreview.msg); if (confirmBtn) confirmBtn.hidden = true; return; }
      var summary = '有效 ' + transferPreview.valid + ' 条；本机已有 ' + transferPreview.existingDuplicates +
        ' 条；文件内重复 ' + transferPreview.duplicates + ' 条；损坏 ' + transferPreview.invalid +
        ' 条；明确过期或超过 180 天 ' + transferPreview.expired + ' 条；超出 50 条上限 ' + transferPreview.overflow + ' 条。';
      if (mode && mode.value === 'replace') summary += ' 替换模式会丢弃本机现有订阅。';
      else summary += ' 合并模式保留本机现有订阅，同 id 不重复添加。';
      transferStatus(summary);
      if (confirmBtn) confirmBtn.hidden = false;
    });
    if (confirmBtn) confirmBtn.addEventListener('click', function () {
      if (!transferPreview) return;
      if (mode && mode.value === 'replace' && !global.confirm('替换后将丢弃本机现有订阅。确认继续？')) return;
      var result = CS.importAlerts(transferText, mode ? mode.value : 'merge');
      if (!result.ok) { transferStatus(result.msg); return; }
      transferStatus('导入完成：共 ' + result.total + ' 条，新增 ' + result.added + ' 条。未调用订阅接口。');
      resetTransferPreview();
      render();
    });
  }

  // 非微信环境：引导卡内联展示服务号关注二维码（微信内走一键授权，不展示）
  function initFollowGuide() {
    var CS = global.CouponStore;
    if (!CS || !CS.fetchOaConfig) return;
    if (CS.isWeixin && CS.isWeixin()) return;
    var box = $('oaGuideQr'), img = $('oaGuideQrImg');
    CS.fetchOaConfig('expiry').then(function (cfg) {
      if (!cfg || !cfg.enabled || !cfg.qr) return;
      if (img) img.src = cfg.qr;
      if (box) box.hidden = false; // 内联展示关注码；保留「开启提醒」按钮（非微信点它仍弹二维码引导）
    }).catch(function () { /* 静默失败：退回原按钮（点击仍会走弹窗展示二维码） */ });
  }

  function boot() {
    var btn = $('oaGuideBtn');
    if (btn && global.CouponStore && global.CouponStore.showRemindGuide) {
      btn.addEventListener('click', function () { global.CouponStore.showRemindGuide(); });
    }
    initFollowGuide();
    initTransfer();
    loadDetailIds(render);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
