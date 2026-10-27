/* ==========================================================================
   store.js · 小满券仓本地数据层（收藏 / 最近看过 / 搜索历史 / 提醒订阅引导）
   —— 纯 localStorage、零依赖、静默失败（无痕模式 / 配额满时不报错，功能自动降级）。
   · 券卡星标：coupon-page.js / list-page.js 生成卡片时调 CouponStore.attachStar；
     预渲染静态券卡由本脚本启动时补增强（包一层 .cp-cell + 收藏按钮，禁 JS 不受影响）。
   · 最近看过：事件委托捕获 .cp-card 点击，从 DOM 反解券快照（上限 24 条）。
   · 收藏上限 100、搜索历史上限 10；数据结构为紧凑快照 {id,did,t,img,url,price,quota,off,at}。
   · 到期/大额提醒：走公众号（服务号）网页授权订阅（web-push / 带参小程序码均已退役）；
     id=tao_id（本机清单主键，历史兼容）、did=_id（详情页 URL 键，供 /my-alerts.html 构造 /p/<_id>.html）。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var K_FAV = 'coupon_favs';
  var K_RECENT = 'coupon_recent';
  var K_SEARCH = 'coupon_searches';
  var K_ALERT = 'coupon_alerts';
  var API_BASE = 'https://api.xuyiheng.com';
  var MAIN_URL = 'coupon.zangeng.com';
  var FAV_MAX = 100;
  var RECENT_MAX = 24;
  var SEARCH_MAX = 10;

  function lsGet(key) {
    try {
      var raw = global.localStorage.getItem(key);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function lsSet(key, arr) {
    try { global.localStorage.setItem(key, JSON.stringify(arr)); } catch (e) { /* 无痕/满配额：静默降级 */ }
  }

  /* ------------------------------- 快照工具 ------------------------------- */
  function numFrom(text, re) {
    var m = String(text || '').match(re);
    return m ? Number(m[1]) : 0;
  }

  // 从券卡 DOM 反解紧凑快照（预渲染卡与运行时卡同构，均带 cp-name/cp-off/cp-final）
  function itemFromCard(a) {
    var cid = (a.getAttribute('data-case') || '').replace(/^coupon:/, '');
    var did = a.getAttribute('data-id') || ''; // 详情页 URL 键＝_id（供 my-alerts 构造 /p/<_id>.html）
    var url = a.href || '';
    var id = cid || url;
    if (!id || id === '#') return null;
    var nameEl = a.querySelector('.cp-name');
    var offEl = a.querySelector('.cp-off');
    var finEl = a.querySelector('.cp-final');
    var imgEl = a.querySelector('img');
    var quota = 0, off = 0;
    if (offEl) {
      quota = numFrom(offEl.textContent, /满(\d+(?:\.\d+)?)减/);
      off = numFrom(offEl.textContent, quota > 0 ? /减(\d+(?:\.\d+)?)/ : /(\d+(?:\.\d+)?)/);
    }
    return {
      id: String(id),
      did: String(did),
      t: nameEl ? (nameEl.textContent || '').trim() : '',
      img: imgEl ? (imgEl.getAttribute('src') || '') : '',
      url: (/^https?:\/\//i.test(url) ? url : ''),
      price: finEl ? numFrom(finEl.textContent, /(\d+(?:\.\d+)?)/) : 0,
      quota: quota,
      off: off,
    };
  }

  /* -------------------------------- 收藏 -------------------------------- */
  function favs() { return lsGet(K_FAV); }

  function isFav(id) {
    if (!id) return false;
    return favs().some(function (f) { return f.id === String(id); });
  }

  // 返回切换后的收藏态（true=已收藏）
  function toggleFav(item) {
    if (!item || !item.id) return false;
    var id = String(item.id);
    var arr = favs();
    var next = arr.filter(function (f) { return f.id !== id; });
    var on = next.length === arr.length; // 原列表没删掉任何东西 → 新收藏
    if (on) next.unshift({ id: id, t: item.t || '', img: item.img || '', url: item.url || '', price: item.price || 0, quota: item.quota || 0, off: item.off || 0, at: Date.now() });
    lsSet(K_FAV, next.slice(0, FAV_MAX));
    return on;
  }

  function removeFav(id) {
    lsSet(K_FAV, favs().filter(function (f) { return f.id !== String(id); }));
  }

  function clearFavs() { lsSet(K_FAV, []); }

  // 导出收藏为 JSON 文本（本地备份 / 跨设备迁移）
  function exportFavs() {
    return JSON.stringify({ v: 1, site: 'coupon.zangeng.com', exportedAt: new Date().toISOString(), favs: favs() });
  }
  // 从 JSON 文本导入收藏：按 id 合并去重、保留已有；返回 {ok:true,added,total} 或 {ok:false,msg}
  function importFavs(text) {
    var obj;
    try { obj = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { ok: false, msg: '不是合法的 JSON 文件' }; }
    var arr = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.favs) ? obj.favs : null);
    if (!arr) return { ok: false, msg: '文件中没有收藏数据' };
    var cur = favs();
    var seen = {};
    cur.forEach(function (f) { if (f && f.id != null) seen[String(f.id)] = 1; });
    var added = 0;
    arr.forEach(function (f) {
      if (!f || f.id == null) return;
      var id = String(f.id);
      if (seen[id]) return;
      cur.push({ id: id, t: f.t || '', img: f.img || '', url: f.url || '', price: Number(f.price) || 0, quota: Number(f.quota) || 0, off: Number(f.off) || 0, at: Number(f.at) || Date.now() });
      seen[id] = 1;
      added++;
    });
    lsSet(K_FAV, cur.slice(0, FAV_MAX));
    return { ok: true, added: added, total: Math.min(cur.length, FAV_MAX) };
  }

  /* ------------------------------ 最近看过 ------------------------------ */
  function recent() { return lsGet(K_RECENT); }

  function pushRecent(item) {
    if (!item || !item.id) return;
    var id = String(item.id);
    var arr = recent().filter(function (f) { return f.id !== id; });
    item = { id: id, t: item.t || '', img: item.img || '', url: item.url || '', price: item.price || 0, quota: item.quota || 0, off: item.off || 0, at: Date.now() };
    arr.unshift(item);
    lsSet(K_RECENT, arr.slice(0, RECENT_MAX));
  }

  function removeRecent(id) {
    lsSet(K_RECENT, recent().filter(function (f) { return f.id !== String(id); }));
  }

  function clearRecent() { lsSet(K_RECENT, []); }

  /* ------------------------------ 搜索历史 ------------------------------ */
  function searches() { return lsGet(K_SEARCH); }

  function pushSearch(kw) {
    kw = String(kw || '').trim();
    if (!kw) return;
    var arr = searches().filter(function (s) { return s !== kw; });
    arr.unshift(kw);
    lsSet(K_SEARCH, arr.slice(0, SEARCH_MAX));
  }

  function clearSearches() { lsSet(K_SEARCH, []); }

  /* ---------------------- 猜你喜欢（M1）本地信号 ---------------------- */
  // 用户信号词：最近看过标题 + 搜索历史，供 coupon-page.js 做子串匹配重排
  function recommendTerms() {
    var terms = [];
    recent().forEach(function (r) { if (r && r.t) terms.push(r.t); });
    searches().forEach(function (s) { if (s) terms.push(s); });
    return terms.slice(0, 16);
  }
  // 已曝光/已收藏的券 id 集合，猜你喜欢去重用
  function seenIds() {
    var s = {};
    favs().forEach(function (f) { if (f && f.id != null) s[String(f.id)] = 1; });
    recent().forEach(function (f) { if (f && f.id != null) s[String(f.id)] = 1; });
    return s;
  }

  /* ---------------------- 降价/到期提醒（M2）本机清单 ---------------------- */
  function alerts() { return lsGet(K_ALERT, []); }
  function isAlert(id) { return alerts().some(function (x) { return x.id === String(id); }); }
  // 切换订阅：本地 localStorage 为主，后端上报为最佳努力（失败忽略）
  function toggleAlert(item) {
    var list = alerts();
    var id = String(item.id);
    if (!id) return false;
    var idx = -1;
    list.forEach(function (x, i) { if (x.id === id) idx = i; });
    var on;
    if (idx >= 0) { list.splice(idx, 1); on = false; }
    else {
      list.unshift({
        id: id, did: String(item.did || ''), t: item.t || '', img: item.img || '', url: item.url || '',
        price: Number(item.price) || 0, quota: Number(item.quota) || 0, off: Number(item.off) || 0,
        baseline: { price: Number(item.price) || 0, quota: Number(item.quota) || 0, couponDiscount: Number(item.off) || 0 },
        ts: Date.now(),
      });
      on = true;
    }
    lsSet(K_ALERT, list.slice(0, 50));
    syncAlert(on ? 'subscribe' : 'unsubscribe', item);
    return on;
  }
  function syncAlert(action, item) {
    var dev = global.Tracker && global.Tracker.visitorId ? global.Tracker.visitorId() : '';
    if (!dev) return;
    var url = (action === 'subscribe' ? '/api/v1/front/coupon/alert/subscribe' : '/api/v1/front/coupon/alert/unsubscribe');
    // sourceGuard 对 /api/v1/front/coupon/ 全量要求携带 mainUrl，否则按「未登记来源」置空（订阅/退订静默失败并刷 P1）
    url += '?mainUrl=' + encodeURIComponent(MAIN_URL);
    try {
      global.fetch(API_BASE + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: dev, tao_id: String(item.id), platform: (item.platform || 'jd'),
          title: item.t || '',
          baseline: { price: Number(item.price) || 0, quota: Number(item.quota) || 0, couponDiscount: Number(item.off) || 0 },
        }),
      }).catch(function () { /* 忽略 */ });
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 到期/大额提醒引导：公众号（服务号）网页授权订阅（web-push / 带参小程序码均已退役） ---------------- */
  var RS_ID = 'coupon-remind-modal';
  var rsKeyHandler = null;

  function oaConfigUrl(type) {
    return API_BASE + '/api/v1/front/coupon/oa/config?type=' + encodeURIComponent(type || 'expiry') +
      '&mainUrl=' + encodeURIComponent(MAIN_URL);
  }
  function oaSubscribeUrl() {
    return API_BASE + '/api/v1/front/coupon/oa/subscribe?mainUrl=' + encodeURIComponent(MAIN_URL);
  }
  function fetchJson(url) {
    return global.fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { return (j && j.data) || {}; });
  }
  function postJson(url, body) {
    return global.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { return (j && j.data) || {}; });
  }

  function closeRemindModal() {
    var m = doc.getElementById(RS_ID);
    if (m && m.parentNode) m.parentNode.removeChild(m);
    if (rsKeyHandler) { doc.removeEventListener('keydown', rsKeyHandler); rsKeyHandler = null; }
  }
  // 通用提示弹窗（标题 + 说明 + 可选服务号关注二维码）
  function openRemindModal(titleText, subText, qrImg) {
    closeRemindModal();
    var mask = doc.createElement('div'); mask.className = 'rs-mask'; mask.id = RS_ID;
    var card = doc.createElement('div'); card.className = 'rs-card';
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
    var title = doc.createElement('div'); title.className = 'rs-title'; title.textContent = titleText;
    var sub = doc.createElement('p'); sub.className = 'rs-sub'; sub.textContent = subText;
    card.appendChild(title); card.appendChild(sub);
    if (qrImg) {
      var img = doc.createElement('img'); img.className = 'rs-img'; img.src = qrImg;
      img.alt = '服务号关注二维码'; img.width = 180; img.height = 180; img.referrerPolicy = 'no-referrer';
      card.appendChild(img);
    }
    var closeBtn = doc.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'rs-close'; closeBtn.textContent = '我知道了';
    card.appendChild(closeBtn);
    mask.appendChild(card);
    doc.body.appendChild(mask);
    rsKeyHandler = function (e) { if (e.key === 'Escape') closeRemindModal(); };
    doc.addEventListener('keydown', rsKeyHandler);
    mask.addEventListener('click', function (e) { if (e.target === mask) closeRemindModal(); });
    closeBtn.addEventListener('click', closeRemindModal);
  }

  // 微信内置浏览器判定：仅微信内可发起服务号网页授权、长按识别二维码
  function isWeixin() {
    return /MicroMessenger|WeChat/i.test((global.navigator && global.navigator.userAgent) || '');
  }

  // 发起服务号网页授权（snsapi_base 静默授权）：回跳当前页并带 code & oa_type
  function startOaAuth(appId, type) {
    var redirect = global.location.origin + global.location.pathname + '?oa_type=' + encodeURIComponent(type);
    var url = 'https://open.weixin.qq.com/connect/oauth2/authorize?appid=' + encodeURIComponent(appId) +
      '&redirect_uri=' + encodeURIComponent(redirect) + '&response_type=code&scope=snsapi_base&state=oa#wechat_redirect';
    global.location.href = url;
  }

  // 点「到期/大额提醒」：探测 OA 通道 → 已开放则发起网页授权；未开放 / 缺 appid 则文案引导（未关注二维码由回调分支展示）
  function showRemindGuide() {
    var type = 'expiry';
    fetchJson(oaConfigUrl(type)).then(function (cfg) {
      if (!cfg || !cfg.enabled) { openRemindModal('提醒暂未开放', '公众号到期/大额提醒暂未开通，可先前往榜单浏览在券好物。'); return; }
      // 非微信环境：跳服务号网页授权无效 → 直接展示关注二维码，引导用微信「扫一扫」关注后进公众号开启
      if (!isWeixin()) { openRemindModal('在微信里开启到期提醒', '当前不在微信内，无法一键授权。请使用微信「扫一扫」扫描下方二维码关注服务号；关注后在微信中重新打开本页，点击券上的「到期提醒」即可开启，届时券到期会通过服务号消息直达本站详情页。', cfg.qr); return; }
      if (!cfg.appId) { openRemindModal('请在微信内开启提醒', '请在微信中打开本页面并关注服务号，即可开启到期/大额券提醒。', cfg.qr); return; }
      startOaAuth(cfg.appId, type);
    }).catch(function () { openRemindModal('网络异常', '暂时无法连接提醒服务，请稍后再试。'); });
  }

  // 网页授权回跳处理：命中 code(+state=oa/oa_type) → 服务端换公众号 openid 订阅；未关注展示关注二维码
  function handleOaCallback(code, type) {
    postJson(oaSubscribeUrl(), { code: code, type: type }).then(function (res) {
      if (res && res.needFollow) {
        openRemindModal('还差一步：关注服务号', '长按识别下方二维码关注服务号，关注后回到本页再次点击「开启提醒」，即可接收到期/大额券直达提醒。', res.qr);
      } else {
        openRemindModal('提醒已开启', '到期/大额券提醒已开启，届时服务号会发送消息并直达本站券详情页，无需再做任何操作。');
      }
    }).catch(function () { openRemindModal('开启失败', '订阅失败，请稍后再试。'); });
  }

  // 点「到期/大额提醒」：记入本机清单（供 /my-alerts.html 降价高亮）+ 走 OA 订阅引导
  function remindNow(item) {
    try { if (item && item.id && !isAlert(item.id)) toggleAlert(item); } catch (e) { /* 忽略 */ }
    showRemindGuide(item);
  }

  // 把「到期提醒」按钮挂到券卡价格行（点击 → 公众号网页授权订阅引导）
  function attachAlert(cardEl, item) {
    if (!cardEl || !item || !item.id) return;
    var price = cardEl.querySelector ? cardEl.querySelector('.cp-price') : null;
    if (!price) return;
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'cp-alert';
    btn.textContent = '到期提醒';
    btn.setAttribute('aria-label', '订阅该券的到期/大额提醒（公众号消息直达本站）');
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      remindNow(item);
      if (global.Conv) global.Conv.track('alert_guide_view', { coupon_id: String(item.id) });
    });
    price.appendChild(btn);
  }

  /* ------------------------------ 券卡星标 ------------------------------ */
  function syncStar(btn, on) {
    btn.textContent = on ? '★' : '☆';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? '取消收藏' : '收藏该券');
    btn.setAttribute('title', on ? '取消收藏' : '收藏该券');
    btn.classList.toggle('is-on', on);
  }

  // 给券卡（<a class="cp-card">）包一层 .cp-cell 并附加收藏星标
  function attachStar(cardEl, item) {
    if (!cardEl || cardEl.parentElement && cardEl.parentElement.classList.contains('cp-cell')) return;
    if (!item || !item.id) return;
    var cell = doc.createElement('div');
    cell.className = 'cp-cell';
    cardEl.parentNode.insertBefore(cell, cardEl);
    cell.appendChild(cardEl);
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'cp-star';
    btn.setAttribute('data-track', 'fav_toggle');
    syncStar(btn, isFav(item.id));
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      syncStar(btn, toggleFav(item));
    });
    cell.appendChild(btn);
    // 分享按钮（M4）：与星标并列，缺 CouponShare 时静默跳过
    if (global.CouponShare && global.CouponShare.attach) {
      try { global.CouponShare.attach(cell, item); } catch (e) { /* 忽略 */ }
    }
    // 到期/大额提醒按钮（M2）：挂到券卡价格行内联
    if (global.CouponStore && global.CouponStore.attachAlert) {
      try { global.CouponStore.attachAlert(cell, item); } catch (e) { /* 忽略 */ }
    }
  }

  // 增强页面里已存在的静态券卡（构建期预渲染产物），运行时卡由各自脚本直接 attachStar
  function enhance(root) {
    if (!root) return;
    var cards = root.querySelectorAll('.cp-card');
    Array.prototype.forEach.call(cards, function (a) {
      if (a.closest && a.closest('.cp-cell')) return;
      attachStar(a, itemFromCard(a));
    });
  }

  // 网页授权回跳自动处理：命中 code + (state=oa 或 oa_type) 即完成订阅并清理 URL（code 一次性、防刷新重放）
  function initOaCallback() {
    try {
      var p = new URLSearchParams(global.location.search || '');
      var code = p.get('code');
      if (!code) return;
      var state = p.get('state');
      var oaType = p.get('oa_type');
      if (state !== 'oa' && !oaType) return; // 非本流程授权回跳，交还其它逻辑
      var type = oaType === 'bigAmount' ? 'bigAmount' : 'expiry';
      p.delete('code'); p.delete('state'); p.delete('oa_type'); p.delete('appid');
      var qs = p.toString();
      var clean = global.location.pathname + (qs ? ('?' + qs) : '') + (global.location.hash || '');
      if (global.history && global.history.replaceState) global.history.replaceState(null, '', clean);
      handleOaCallback(code, type);
    } catch (e) { /* 忽略 */ }
  }

  // 非微信环境：站内底部轻量关注引导条（列表/详情页通用，本函数注入；my-alerts 已有内联卡故跳过；可关闭并记忆）
  function mountFollowBanner() {
    if (isWeixin()) return;
    try { if (global.localStorage.getItem('coupon_oa_banner') === '1') return; } catch (e) { /* 无痕忽略 */ }
    if (/my-alerts/i.test(global.location.pathname || '')) return;
    fetchJson(oaConfigUrl('expiry')).then(function (cfg) {
      if (!cfg || !cfg.enabled || !cfg.qr) return;
      if (doc.getElementById('oaBanner')) return;
      var bar = doc.createElement('div'); bar.className = 'oa-banner'; bar.id = 'oaBanner';
      var img = doc.createElement('img'); img.className = 'oa-banner-qr'; img.alt = '服务号关注二维码'; img.referrerPolicy = 'no-referrer'; img.src = cfg.qr;
      var txt = doc.createElement('div'); txt.className = 'oa-banner-txt';
      var strong = doc.createElement('strong'); strong.textContent = '开启券到期提醒';
      var span = doc.createElement('span'); span.textContent = '微信「扫一扫」关注服务号，到期/大额券消息直达本站（手机可先截图再到微信里识别）。';
      txt.appendChild(strong); txt.appendChild(span);
      var cta = doc.createElement('button'); cta.type = 'button'; cta.className = 'btn btn-sm oa-banner-cta'; cta.textContent = '如何开启';
      cta.addEventListener('click', function () { showRemindGuide(); });
      var close = doc.createElement('button'); close.type = 'button'; close.className = 'oa-banner-close'; close.setAttribute('aria-label', '关闭'); close.textContent = '\u00d7';
      close.addEventListener('click', function () { try { global.localStorage.setItem('coupon_oa_banner', '1'); } catch (e) { /* 忽略 */ } if (bar.parentNode) bar.parentNode.removeChild(bar); });
      bar.appendChild(img); bar.appendChild(txt); bar.appendChild(cta); bar.appendChild(close);
      doc.body.appendChild(bar);
    }).catch(function () { /* 静默失败：不打扰 */ });
  }

  function boot() {
    Array.prototype.forEach.call(doc.querySelectorAll('.cp-grid'), enhance);
    // 点击券卡 = 视为「看过」，写最近看过快照（星标按钮在 a 外，不会误触）
    doc.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('.cp-card') : null;
      if (!a) return;
      if (a.getAttribute('href') === '#' || !a.getAttribute('href')) return;
      pushRecent(itemFromCard(a));
    });
    initOaCallback();
    mountFollowBanner();
  }

  global.CouponStore = {
    favs: favs, isFav: isFav, toggleFav: toggleFav, removeFav: removeFav, clearFavs: clearFavs,
    exportFavs: exportFavs, importFavs: importFavs,
    recent: recent, pushRecent: pushRecent, removeRecent: removeRecent, clearRecent: clearRecent,
    searches: searches, pushSearch: pushSearch, clearSearches: clearSearches,
    recommendTerms: recommendTerms, seenIds: seenIds,
    alerts: alerts, isAlert: isAlert, toggleAlert: toggleAlert, attachAlert: attachAlert,
    showRemindGuide: showRemindGuide, remindNow: remindNow,
    isWeixin: isWeixin, fetchOaConfig: function (type) { return fetchJson(oaConfigUrl(type || 'expiry')); },
    itemFromCard: itemFromCard, attachStar: attachStar, enhance: enhance,
  };

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
