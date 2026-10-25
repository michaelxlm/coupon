/* ==========================================================================
   my-alerts.js · 降价提醒中心（W5 · /my-alerts.html）
   —— 本地订阅清单（CouponStore.alerts）+ 当前力度对比：
     批量 fetch /coupon/jd/priceBatch 取每券最近快照，与订阅基线比较，
     到手价下降或券面额提升 → 卡片高亮 + 「已降/加码」标记。
   —— 小程序引导（web-push 已下线）：页面顶部渲染「去小程序订阅提醒」引导卡；每张已订阅券
     卡内嵌该券的带参数小程序码（/coupon/mpcode?tao_id=&mainUrl=），扫码进小程序落到当前券。
   —— 详情页承接：命中 /data/coupon-snapshot.json 的 detailIds 白名单才给「详情」链接，
     避免链到未生成的 /p/<id>（404）。
   —— 静默失败：任何接口异常只退回基线展示，不报错。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var API_BASE = 'https://api.xuyiheng.com';
  var MAIN_URL = 'coupon.zangeng.com';

  function $(id) { return doc.getElementById(id); }
  function num(v) { return (Math.round(Number(v) * 100) / 100) || 0; }

  /* ---------------- 小程序码图片 URL（web-push 下线后落当前券） ---------------- */
  // scene=券 tao_id；带 mainUrl 过后端 sourceGuard 来源守卫（与 priceBatch 同口径）
  function mpCodeUrl(taoId) {
    if (!taoId) return '';
    return API_BASE + '/api/v1/front/coupon/mpcode?tao_id=' + encodeURIComponent(String(taoId)) +
      '&mainUrl=' + encodeURIComponent(MAIN_URL);
  }

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

    // 带参小程序码（web-push 下线后落当前券）：扫码进小程序 onLoad 读 scene=tao_id 定位该券
    if (a.id) {
      var mp = doc.createElement('div');
      mp.className = 'ma-mpcode';
      var mpImg = doc.createElement('img');
      mpImg.src = mpCodeUrl(a.id);
      mpImg.alt = '小程序码：' + (a.t || '优惠券');
      mpImg.loading = 'lazy';
      mpImg.referrerPolicy = 'no-referrer';
      mpImg.width = 120; mpImg.height = 120;
      mp.appendChild(mpImg);
      var mpCap = doc.createElement('span');
      mpCap.className = 'ma-mpcode-cap';
      mpCap.textContent = '微信扫码进小程序 · 顶部订阅到期/大额提醒';
      mp.appendChild(mpCap);
      bodyEl.appendChild(mp);
    }

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
    if (detailIdSet && detailIdSet[String(a.id)]) {
      var det = doc.createElement('a');
      det.className = 'btn btn-sm btn-ghost'; det.href = '/p/' + encodeURIComponent(String(a.id)) + '.html'; det.textContent = '详情';
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

  function boot() {
    loadDetailIds(render);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
