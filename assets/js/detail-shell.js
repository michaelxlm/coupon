/* ==========================================================================
   detail-shell.js · /p/_shell.html 动态详情页水合（nginx ^~ /p/ try_files 回退壳）
   —— 未预渲染的券（长尾 / 新券 / 旧链）落到本壳：从 URL 取券键 → jd/detail?id= 水合 hero，
      成功则注入 canonical / title / description / robots(index,follow)，并追加加载 detail-page.js
      复用其价格走势 / 倒计时 / 订阅 / 分享逻辑；取不到券展示空态引导榜单、保持 noindex。
   —— 券键兼容：_id（24hex）优先；亦接受 tao_id（jd/detail 对两者均支持）。canonical 恒用取回券的 _id，
      旧键 URL 水合后 history.replaceState 归一到 /p/<_id>.html，避免同券多 URL 判重。
   —— 静默失败：任何 fetch/DOM 异常都不阻断页面，退化为空态。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var API_BASE = 'https://api.xuyiheng.com';
  var MAIN_URL = 'coupon.zangeng.com';
  var SITE = 'https://coupon.zangeng.com';
  var PREFIX = '/api/v1/front/coupon/jd';

  function num(v) { return (Math.round(Number(v) * 100) / 100) || 0; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : ''; }
  function cardLink(c) { return safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url) || ''; }
  // 券键归一：兼容 hex 字符串 / 驱动扩展 JSON { $oid } / ObjectId 实例
  function normId(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      if (typeof v.$oid === 'string') return v.$oid;
      if (typeof v.toHexString === 'function') return v.toHexString();
      if (v.id) return String(v.id);
    }
    return String(v);
  }

  // 从 /p/<key>.html 取 key（排除 _shell 自身）；兼容 ?id=
  function keyFromUrl() {
    var m = /\/p\/([^\/?#]+)\.html/i.exec(global.location.pathname || '');
    if (m && m[1] && m[1] !== '_shell') { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    var q = /[?&]id=([^&]+)/.exec(global.location.search || '');
    if (q && q[1]) { try { return decodeURIComponent(q[1]); } catch (e) { return q[1]; } }
    return '';
  }

  function upsertMeta(attr, key, content) {
    var el = doc.head.querySelector('meta[' + attr + '="' + key + '"]');
    if (!el) { el = doc.createElement('meta'); el.setAttribute(attr, key); doc.head.appendChild(el); }
    el.setAttribute('content', content);
  }
  function setCanonical(url) {
    var el = doc.head.querySelector('link[rel="canonical"]');
    if (!el) { el = doc.createElement('link'); el.setAttribute('rel', 'canonical'); doc.head.appendChild(el); }
    el.setAttribute('href', url);
  }

  var body = doc.body;
  var key = keyFromUrl();

  function showEmpty() {
    var empty = doc.getElementById('pdEmpty');
    var content = doc.getElementById('pdContent');
    var trendSec = doc.getElementById('pdTrendSec');
    var recSec = doc.getElementById('pdRecSec');
    if (content) content.hidden = true;
    if (trendSec) trendSec.hidden = true;
    if (recSec) recSec.hidden = true;
    if (empty) empty.hidden = false;
    upsertMeta('name', 'robots', 'noindex,follow');
  }

  if (!key) { showEmpty(); return; }

  var detailUrl = API_BASE + PREFIX + '/detail?id=' + encodeURIComponent(key) +
    '&mainUrl=' + encodeURIComponent(MAIN_URL);
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 12000);
  fetch(detailUrl, { signal: ctrl.signal, headers: { 'User-Agent': 'coupon-site/1.0' } })
    .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (j) {
      var c = j && j.data && j.data.coupon;
      if (!c) { showEmpty(); return; }
      hydrate(c);
    })
    .catch(function () { clearTimeout(timer); showEmpty(); });

  function hydrate(c) {
    var did = normId(c._id) || key; // canonical 键：取回券的 _id（无则回落请求 key）
    var finalUrl = SITE + '/p/' + encodeURIComponent(did) + '.html';
    var off = num(c.couponDiscount) || 0;
    var quota = num(c.couponQuota) || 0;
    var price = num(c.price) || 0;
    var power = off > 0 ? (quota > 0 ? ('满' + quota + '减' + off) : ('立减 ¥' + off)) : '';
    var img = safeUrl(c.pict_url);
    var link = cardLink(c);
    var pageTitle = (c.title || '优惠券') + (power ? (' 满' + quota + '减' + off) : '') + (price > 0 ? (' 到手¥' + price) : '') + ' · 券详情 | 小满券仓';
    var pageDesc = (c.title || '优惠券') + (off > 0 ? ('，当前券力度 满' + quota + '减' + off) : '') + (price > 0 ? ('，到手约 ¥' + price) : '') + '。查看价格走势、订阅降价提醒，先领券再下单更省；最终优惠以商家活动页为准。';

    // SEO 一致化：canonical 指向 _id URL、翻 index,follow、注入 title/desc/og
    doc.title = pageTitle;
    setCanonical(finalUrl);
    upsertMeta('name', 'robots', 'index,follow');
    upsertMeta('name', 'description', pageDesc);
    upsertMeta('property', 'og:title', pageTitle);
    upsertMeta('property', 'og:description', pageDesc);
    upsertMeta('property', 'og:url', finalUrl);
    if (img) upsertMeta('property', 'og:image', img);
    // 旧键 URL（tao_id / safeId）水合后归一到 _id URL，防同券多 URL 判重
    if (global.history && global.history.replaceState && finalUrl !== global.location.href) {
      try { global.history.replaceState(null, '', finalUrl); } catch (e) { /* 跨域或安全限制忽略 */ }
    }

    // body data-* 供随后加载的 detail-page.js 读取（价格趋势按 tao_id、倒计时按 end、订阅/分享按此 item）
    body.setAttribute('data-id', did);
    body.setAttribute('data-tao-id', String(c.tao_id || ''));
    body.setAttribute('data-title', c.title || '');
    body.setAttribute('data-img', img);
    body.setAttribute('data-price', price);
    body.setAttribute('data-quota', quota);
    body.setAttribute('data-off', off);
    body.setAttribute('data-url', link);
    body.setAttribute('data-platform', c.platform || 'jd');
    body.setAttribute('data-end', c.couponEndTime || '');

    // 填充 hero
    var media = doc.getElementById('pdMedia');
    if (media && img) {
      media.innerHTML = '<img src="' + esc(img) + '" alt="' + esc(c.title || '') + '" width="600" height="600" decoding="async" referrerpolicy="no-referrer">';
    }
    var tEl = doc.getElementById('pdTitle'); if (tEl) tEl.textContent = c.title || '优惠券';
    var pEl = doc.getElementById('pdPower'); if (pEl) pEl.textContent = power;
    var fEl = doc.getElementById('pdFinal'); if (fEl && price > 0) fEl.innerHTML = '到手价 <strong>¥' + esc(price) + '</strong>';
    var cta = doc.getElementById('pdClaim');
    if (cta) {
      if (link) { cta.setAttribute('href', link); cta.setAttribute('data-case', 'coupon:' + String(c.tao_id || did)); }
      else { cta.setAttribute('href', '#'); cta.setAttribute('aria-disabled', 'true'); }
    }

    renderRelated(c);
    loadDetailPage();
  }

  // 相关推荐：按标题词做后端召回（/recommend），取到则渲染卡；失败留空（不阻断）
  function renderRelated(c) {
    var box = doc.getElementById('pdRec');
    if (!box) return;
    var terms = String(c.title || '').slice(0, 30);
    var seen = String(c.tao_id || '');
    var url = API_BASE + PREFIX + '/recommend?limit=6&terms=' + encodeURIComponent(terms) +
      '&seen=' + encodeURIComponent(seen) + '&mainUrl=' + encodeURIComponent(MAIN_URL);
    var rc = new AbortController();
    var rt = setTimeout(function () { rc.abort(); }, 12000);
    fetch(url, { signal: rc.signal, headers: { 'User-Agent': 'coupon-site/1.0' } })
      .then(function (r) { clearTimeout(rt); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var list = (j && j.data && Array.isArray(j.data.list)) ? j.data.list : [];
        box.innerHTML = list.map(cardHtml).join('\n          ');
      })
      .catch(function () { clearTimeout(rt); });
  }

  function cardHtml(c) {
    var link = cardLink(c);
    var did = normId(c._id);
    var cid = String(c.tao_id || did || '');
    var off = num(c.couponDiscount) || 0;
    var quota = num(c.couponQuota) || 0;
    var price = num(c.price) || 0;
    var img = safeUrl(c.pict_url);
    var rel = link ? ' rel="sponsored noopener"' : '';
    var href = link ? esc(link) : '#';
    var h = '<a class="cp-card" href="' + href + '"' + rel + ' target="_blank" data-track="coupon_click"';
    if (cid) h += ' data-case="coupon:' + esc(cid) + '"';
    if (did) h += ' data-id="' + esc(did) + '"';
    h += '>';
    if (img) h += '<img src="' + esc(img) + '" alt="' + esc(c.title || '') + '" width="300" height="300" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
    h += '<span class="cp-name">' + esc(c.title || '优惠券') + '</span><div class="cp-price">';
    if (off > 0) h += '<span class="cp-off">' + esc(quota > 0 ? ('满' + quota + '减' + off) : ('券 ¥' + off)) + '</span>';
    if (price > 0) h += '<span class="cp-final">¥' + esc(price) + '</span>';
    h += '</div></a>';
    return h;
  }

  // hero 水合完成后再加载 detail-page.js（其 IIFE 立即读 body data-* 并跑趋势/倒计时/订阅/分享）
  function loadDetailPage() {
    var s = doc.createElement('script');
    s.src = '/assets/js/detail-page.js';
    s.async = false;
    doc.body.appendChild(s);
  }
})(window);
