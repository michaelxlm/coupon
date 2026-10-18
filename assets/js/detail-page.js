/* ==========================================================================
   detail-page.js · 券详情页交互（W1 · /p/<tao_id>.html）
   —— 渐进增强：页面壳与券信息由 build.js 预渲染写死，本脚本只做三件事：
     1) 价格走势：fetch /coupon/jd/priceTrend（每日力度快照）画 SVG 折线 + 摘要；
     2) 订阅降价提醒 / 分享海报按钮（复用 store.js toggleAlert 与 share.js openShare）；
     3) 临近失效倒计时（有 couponEndTime 时逐秒刷新）。
   —— 静默失败：任何 fetch/DOM 异常都不影响页面浏览，走势区退化为文字说明。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var API_BASE = 'https://api.xuyiheng.com';
  var MAIN_URL = 'coupon.zangeng.com';
  var PREFIX = '/api/v1/front/coupon/jd';

  var body = doc.body;
  var item = {
    id: body.getAttribute('data-tao-id') || '',
    t: body.getAttribute('data-title') || '优惠券',
    img: body.getAttribute('data-img') || '',
    url: body.getAttribute('data-url') || '',
    price: Number(body.getAttribute('data-price')) || 0,
    quota: Number(body.getAttribute('data-quota')) || 0,
    off: Number(body.getAttribute('data-off')) || 0,
    platform: body.getAttribute('data-platform') || 'jd',
  };

  function num(v) { return (Math.round(Number(v) * 100) / 100) || 0; }

  /* ------------------------------ 价格走势 ------------------------------ */
  function fetchTrend(cb) {
    if (!item.id) return cb(null);
    var url = API_BASE + PREFIX + '/priceTrend?tao_id=' + encodeURIComponent(item.id) +
      '&limit=30&mainUrl=' + encodeURIComponent(MAIN_URL);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 12000);
    fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'coupon-site/1.0' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        clearTimeout(timer);
        var list = j && j.data && Array.isArray(j.data.list) ? j.data.list : [];
        cb(list.length >= 2 ? list : null);
      })
      .catch(function () { clearTimeout(timer); cb(null); });
  }

  // 画折线：横轴时间序（快照已升序），纵轴到手价；叠加力度（券面额）变化摘要
  function drawTrend(points) {
    var box = doc.getElementById('pTrend');
    var sum = doc.getElementById('pTrendSummary');
    if (!box) return;
    if (!points) {
      if (sum) sum.textContent = '暂无历史走势快照（新收录的券快照需累计 2 天以上）';
      return;
    }
    var W = 600, H = 160, pad = 26;
    var prices = points.map(function (p) { return num(p.price) || 0; });
    var offs = points.map(function (p) { return num(p.couponDiscount) || 0; });
    var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices);
    var span = (max - min) || 1;
    var ns = 'http://www.w3.org/2000/svg';
    var svg = doc.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', H);
    svg.setAttribute('aria-hidden', 'true');
    var pts = points.map(function (p, i) {
      var x = pad + i * ((W - pad * 2) / Math.max(1, points.length - 1));
      var y = H - pad - ((prices[i] - min) / span) * (H - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var line = doc.createElementNS(ns, 'polyline');
    var down = prices[prices.length - 1] <= prices[0];
    line.setAttribute('points', pts);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', down ? '#16a34a' : '#e4393c');
    line.setAttribute('stroke-width', '2');
    svg.appendChild(line);
    var last = pts.split(' ')[pts.split(' ').length - 1].split(',');
    var dot = doc.createElementNS(ns, 'circle');
    dot.setAttribute('cx', last[0]); dot.setAttribute('cy', last[1]); dot.setAttribute('r', '3.5');
    dot.setAttribute('fill', down ? '#16a34a' : '#e4393c');
    svg.appendChild(dot);
    var lo = doc.createElementNS(ns, 'text');
    lo.setAttribute('x', pad); lo.setAttribute('y', '12'); lo.setAttribute('font-size', '11'); lo.setAttribute('fill', '#999');
    lo.textContent = '高 ¥' + num(max);
    svg.appendChild(lo);
    var hi = doc.createElementNS(ns, 'text');
    hi.setAttribute('x', pad); hi.setAttribute('y', H - 6); hi.setAttribute('font-size', '11'); hi.setAttribute('fill', '#999');
    hi.textContent = '低 ¥' + num(min);
    svg.appendChild(hi);
    box.innerHTML = '';
    box.appendChild(svg);
    if (sum) {
      var offDelta = offs[offs.length - 1] - offs[0];
      var priceDelta = num(prices[0] - prices[prices.length - 1]);
      var bits = [];
      if (priceDelta > 0) bits.push('近 ' + points.length + ' 次快照到手价已降 ¥' + priceDelta);
      else if (priceDelta < 0) bits.push('近 ' + points.length + ' 次快照到手价上浮 ¥' + (-priceDelta));
      else bits.push('近 ' + points.length + ' 次快照到手价平稳');
      if (offDelta > 0) bits.push('券力度加码 ¥' + offDelta);
      sum.textContent = bits.join('，') + '。';
    }
  }

  /* -------------------------- 订阅提醒 / 分享 -------------------------- */
  function wireAlert() {
    var btn = doc.getElementById('pAlert');
    if (!btn || !item.id || !global.CouponStore) return;
    function sync(on) {
      btn.textContent = on ? '已订阅降价提醒' : '订阅降价提醒';
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    sync(global.CouponStore.isAlert(item.id));
    btn.addEventListener('click', function () {
      var on = global.CouponStore.toggleAlert(item);
      sync(on);
      if (global.Conv) global.Conv.track('alert_toggle', { coupon_id: item.id, on: on ? 1 : 0 });
    });
  }

  function wireShare() {
    var btn = doc.getElementById('pShare');
    if (!btn || !global.CouponShare) return;
    btn.addEventListener('click', function () {
      global.CouponShare.openShare(item);
    });
  }

  /* ------------------------------ 失效倒计时 ------------------------------ */
  function wireCountdown() {
    var el = doc.getElementById('pdExpire');
    var raw = body.getAttribute('data-end');
    if (!el || !raw) return;
    var ms = /^\d+$/.test(raw) ? (raw.length >= 12 ? Number(raw) : Number(raw) * 1000) : Date.parse(raw.replace(/\.\d+/, '').replace(/-/g, '/'));
    if (!ms || isNaN(ms)) return;
    function tick() {
      var diff = ms - Date.now();
      if (diff <= 0) { el.textContent = '已过期，力度仅供参考'; return; }
      var d = Math.floor(diff / 86400000);
      var h = Math.floor(diff % 86400000 / 3600000);
      var m = Math.floor(diff % 3600000 / 60000);
      el.textContent = (d > 0 ? d + ' 天 ' : '') + h + ' 时 ' + m + ' 分后失效';
      if (diff < 3 * 86400000) el.classList.add('is-urgent');
    }
    tick();
    global.setInterval(tick, 60000);
  }

  wireAlert();
  wireShare();
  wireCountdown();
  fetchTrend(drawTrend);
})(window);
