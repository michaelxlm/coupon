/* ==========================================================================
   price-compare.js · WO-189 跨平台同款比价（渐进增强，零依赖）
   —— 挂载点：券详情页 <section id="pCompareSection">（build.js 的 detailPageShell 模板输出）；
      存量 /p/*.html 未带该节点时，本模块自行创建并插入到「价格走势」区之后。
      脚本由 detail-page.js 动态补加载（口径同 detail-shell.js → detail-page.js），
      若构建模板已带静态 <script> 则不会重复加载（见 detail-page.js 的守卫）。

   数据口径（诚实，硬约束）：
     · 只读可选离线产物 /data/cross-platform-offers.json（由 scripts/build-cross-platform.js
       从 data/coupon-snapshot.json 生成）。产物缺省 / 读取失败 / 非法 → 渲染
       「暂无可比价数据」空态，绝不在前端临时拼凑其它平台报价。
     · 只展示产物中「真实存在」的 platform 与到手价；平台名未知时原样显示 platform 值，
       不映射成 pdd / douyin 等未接入平台。
     · 某款只有单一平台报价 → 明确显示「当前仅 1 个平台报价，暂不构成立足比价」，
       不补第二行、不伪造差额。
     · 差额 = 该报价 - 本组最低到手价；最低者标「最低价」。
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = global.document;
  var DATA_URL = '/data/cross-platform-offers.json';
  var CSS_HREF = '/assets/css/price-compare.css';
  var CSS_ID = 'cpCompareCss';
  var SECTION_ID = 'pCompareSection';
  var SUMMARY_ID = 'cpCompareSummary';
  var BODY_ID = 'cpCompareBody';
  var TIMEOUT_MS = 6000;
  var PLATFORM_LABELS = { jd: '京东', taobao: '淘宝', pdd: '拼多多', douyin: '抖音', other: '其他' };
  var booted = false;

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function platformLabel(p) {
    var k = String(p == null ? '' : p).trim().toLowerCase();
    return k ? (PLATFORM_LABELS[k] || k) : '未标注平台';
  }

  function money(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  }

  /* 与 scripts/build-cross-platform.js 的 normalizeTitle 同口径：改动需两处同步。
     仅用于按当前页标题回退匹配同款组；主键匹配优先用 _id / tao_id，不依赖文本猜测。 */
  var PROMO_WORDS = [
    '优惠券', '领券', '券后', '大额券', '内部券', '隐藏券', '专属券',
    '包邮', '秒杀', '限时', '特价', '爆款', '旗舰店', '官方', '正品', '新品',
    '热卖', '直降', '满减', '买一送一', '第二件', '双十一', '双11', '618',
    '预售', '付定金', '定金', '到手价', '立减', '赠品', '免邮', '全国包邮',
    '超级', '狂欢', '活动', '专享', '限量', '抢购', '补贴', '百亿', '划算',
    '推荐', '优选', '自营', '同款', '现货', '速发', '礼盒', '新款', '升级款',
    '加量', '促销', '优惠', '京东', '淘宝', '天猫', '拼多多', '抖音', '专属',
    '折上折', '省钱', '必买', '清单', '攻略', '合集',
  ];
  var SPEC_RE = /\d+(?:\.\d+)?(?:ml|l|g|kg|mg|斤|两|片|支|袋|盒|包|条|只|个|件|套|罐|瓶|粒|枚|张|本|台|部|双|对|米|cm|mm|寸|gb|tb)/gi;
  var NUM_PROMO_RE = [
    /满\d+(?:\.\d+)?减\d+(?:\.\d+)?/g,
    /\d+(?:\.\d+)?折/g,
    /\d+(?:\.\d+)?元/g,
    /第\d+件/g,
    /\d+(?:\.\d+)?起/g,
  ];
  function normalizeTitle(raw) {
    var s = String(raw == null ? '' : raw).toLowerCase();
    s = s.replace(/[\s\u3000]+/g, '');
    s = s.replace(/【[^】]*】/g, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/（[^）]*）/g, '')
      .replace(/\([^)]*\)/g, '');
    for (var i = 0; i < PROMO_WORDS.length; i++) s = s.split(PROMO_WORDS[i]).join('');
    s = s.replace(SPEC_RE, '');
    for (var j = 0; j < NUM_PROMO_RE.length; j++) s = s.replace(NUM_PROMO_RE[j], '');
    s = s.replace(/[\/\\|+&·,，。!！?？~～:：;；'"“”‘’*#\-—_]/g, '');
    return s;
  }

  /* ------------------------------ 挂载点 ------------------------------ */
  function ensureCss() {
    if (doc.getElementById(CSS_ID)) return;
    var link = doc.createElement('link');
    link.id = CSS_ID;
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    doc.head.appendChild(link);
  }

  function ensureSection() {
    var sec = doc.getElementById(SECTION_ID);
    if (!sec) {
      sec = el('section', 'section section-soft cp-compare-section');
      sec.id = SECTION_ID;
      sec.setAttribute('data-cp-compare', '1');
      sec.innerHTML = '<div class="container"><div class="section-head left">'
        + '<h2>跨平台同款比价</h2>'
        + '<p class="section-desc" id="' + SUMMARY_ID + '">正在读取可比价数据…</p>'
        + '</div><div id="' + BODY_ID + '" class="cp-compare-body"></div></div>';
      // 优先插到「价格走势」section 之后；否则退到 main / body 末尾
      var trend = doc.getElementById('pTrend');
      var trendSec = trend && trend.closest ? trend.closest('section') : null;
      if (trendSec && trendSec.parentNode) trendSec.parentNode.insertBefore(sec, trendSec.nextSibling);
      else (doc.getElementById('main') || doc.body).appendChild(sec);
    }
    sec.hidden = false; // 有数据、空态都展示，不隐藏误导
    var summary = doc.getElementById(SUMMARY_ID);
    var body = doc.getElementById(BODY_ID);
    if (!summary) {
      summary = el('p', 'section-desc');
      summary.id = SUMMARY_ID;
      sec.insertBefore(summary, sec.firstChild);
    }
    if (!body) {
      body = el('div', 'cp-compare-body');
      body.id = BODY_ID;
      sec.appendChild(body);
    }
    return { summary: summary, body: body };
  }

  /* ------------------------------ 渲染 ------------------------------ */
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function noteLine(body, platformsSeen) {
    var ps = (platformsSeen && platformsSeen.length) ? platformsSeen.map(platformLabel).join(' / ') : '（产物未标注平台）';
    body.appendChild(el('p', 'cp-compare-note',
      '本模块仅展示券快照中真实存在的平台报价（当前快照：' + ps
      + '）；未接入平台不生成任何报价或点击数据，价格以商家活动页为准。'));
  }

  function renderEmpty(parts, reason) {
    parts.summary.textContent = '暂无可比价数据';
    clear(parts.body);
    parts.body.appendChild(el('p', 'cp-compare-empty',
      '暂无可比价数据' + (reason ? '（' + reason + '）' : '') + '。'));
    parts.body.appendChild(el('p', 'cp-compare-note',
      '离线产物 data/cross-platform-offers.json 缺省时不做任何编造；'
      + '如需启用，请跑 node scripts/build-cross-platform.js 从 data/coupon-snapshot.json 生成。'));
  }

  function renderOfferRows(offers, body, showLowest) {
    var valid = offers.filter(function (o) { return o && o.platform && Number(o.price) > 0; });
    if (!valid.length) return 0;
    valid.sort(function (a, b) { return Number(a.price) - Number(b.price) || String(a.platform).localeCompare(String(b.platform)); });
    var min = money(valid[0].price);
    var table = el('div', 'cp-compare-table');
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', '跨平台同款报价对比');
    var head = el('div', 'cp-compare-head');
    head.setAttribute('role', 'row');
    ['平台', '到手价', '差额', '商品标题'].forEach(function (t) {
      var c = el('span', '', t); c.setAttribute('role', 'columnheader'); head.appendChild(c);
    });
    table.appendChild(head);
    valid.forEach(function (o, i) {
      var row = el('div', 'cp-compare-row' + (showLowest && i === 0 ? ' is-lowest' : ''));
      row.setAttribute('role', 'row');
      var plat = el('span', 'cp-compare-plat', platformLabel(o.platform));
      plat.setAttribute('data-plat', String(o.platform));
      plat.setAttribute('role', 'cell');
      var price = el('span', 'cp-compare-price', '¥' + money(o.price));
      price.setAttribute('role', 'cell');
      var diff;
      if (!showLowest) {
        diff = el('span', 'cp-compare-diff', '—');
      } else if (i === 0) {
        diff = el('span', 'cp-compare-badge', '最低价');
      } else {
        diff = el('span', 'cp-compare-diff', '贵 ¥' + money(money(o.price) - min));
      }
      diff.setAttribute('role', 'cell');
      var title = el('span', 'cp-compare-title', String(o.title || ''));
      title.setAttribute('role', 'cell');
      title.setAttribute('title', String(o.title || ''));
      row.appendChild(plat); row.appendChild(price); row.appendChild(diff); row.appendChild(title);
      table.appendChild(row);
    });
    body.appendChild(table);
    return min;
  }

  function renderGroup(g, parts, platformsSeen) {
    var offers = Array.isArray(g.offers) ? g.offers : [];
    if (!offers.length) { renderEmpty(parts, '该同款组无有效报价'); return; }
    clear(parts.body);
    var platCount = g.platformCount != null ? Number(g.platformCount) : new Set(offers.map(function (o) { return o.platform; })).size;
    if (platCount <= 1) {
      // 诚实口径：只有单一平台报价，不构造比价、不补第二行
      parts.summary.textContent = '当前仅 1 个平台报价，暂不构成立足比价';
      parts.body.appendChild(el('p', 'cp-compare-warn',
        '当前仅 1 个平台报价，暂不构成立足比价；本站不会为缺失平台编造价格或差额。'));
      renderOfferRows(offers, parts.body, false);
    } else {
      var min = renderOfferRows(offers, parts.body, true);
      parts.summary.textContent = String(g.label || '同款商品') + ' · ' + platCount + ' 个平台报价，最低 ¥' + min;
    }
    noteLine(parts.body, platformsSeen);
  }

  function renderGroupList(groups, body) {
    var ul = el('ul', 'cp-compare-mini');
    groups.forEach(function (g) {
      var li = el('li', '');
      li.appendChild(el('span', 'cp-compare-mini-name', String(g.label || g.key || '同款商品')));
      li.appendChild(el('span', 'cp-compare-mini-meta',
        g.platformCount + ' 个平台 · 最低 ¥' + money(g.minPrice) + ' · 差额 ¥' + money(g.diff)));
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }

  function context() {
    var b = doc.body;
    return {
      id: String(b.getAttribute('data-id') || ''),
      taoId: String(b.getAttribute('data-tao-id') || ''),
      title: String(b.getAttribute('data-title') || ''),
    };
  }

  // 主键（_id / tao_id）精确匹配优先；失败才用与构建脚本同口径的标题归一化回退
  function matchGroup(items, ctx) {
    if (!ctx.id && !ctx.taoId && !ctx.title) return null;
    for (var i = 0; i < items.length; i++) {
      var g = items[i];
      if (!g || !Array.isArray(g.offers)) continue;
      for (var j = 0; j < g.offers.length; j++) {
        var o = g.offers[j];
        if (!o) continue;
        if (ctx.taoId && String(o.tao_id || '') === ctx.taoId) return g;
        if (ctx.id && String(o._id || '') === ctx.id) return g;
      }
    }
    var key = normalizeTitle(ctx.title);
    if (key.length >= 4) {
      for (var k = 0; k < items.length; k++) if (items[k] && items[k].key === key) return items[k];
    }
    return null;
  }

  function renderData(data, parts) {
    var items = data && Array.isArray(data.items) ? data.items : [];
    var platformsSeen = data && Array.isArray(data.platformsSeen) ? data.platformsSeen : [];
    if (!items.length) { renderEmpty(parts, '产物中暂无同款组'); return; }
    var matched = matchGroup(items, context());
    if (matched) { renderGroup(matched, parts, platformsSeen); return; }

    // 当前商品未命中同款组：如实说明，并列出产物中真实存在的其它可比价同款（若有）
    var comparable = items.filter(function (g) { return g && g.comparable && Number(g.platformCount) >= 2; });
    clear(parts.body);
    if (!comparable.length) {
      parts.summary.textContent = '当前券快照暂无跨平台同款报价';
      parts.body.appendChild(el('p', 'cp-compare-empty', '当前券快照暂无跨平台同款报价。'));
      parts.body.appendChild(el('p', 'cp-compare-warn',
        '快照中每个同款归并组都只有 1 个平台报价，暂不构成立足比价；不生成缺失平台价格。'));
    } else {
      parts.summary.textContent = '当前商品暂无同款跨平台报价 · 以下为其它可比价同款';
      parts.body.appendChild(el('p', 'cp-compare-empty', '当前商品暂无同款跨平台报价。'));
      renderGroupList(comparable.slice(0, 4), parts.body);
    }
    noteLine(parts.body, platformsSeen);
  }

  /* ------------------------------ 启动 ------------------------------ */
  function boot() {
    if (booted) return;
    booted = true;
    var parts;
    try { ensureCss(); parts = ensureSection(); }
    catch (e) { return; } // 静默失败：不影响详情页浏览
    if (!global.fetch) { renderEmpty(parts, '浏览器不支持 fetch'); return; }

    var ctrl = global.AbortController ? new global.AbortController() : null;
    var timer = global.setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e2) { /* 忽略 */ } } }, TIMEOUT_MS);
    var opts = { cache: 'no-store' };
    if (ctrl) opts.signal = ctrl.signal;
    global.fetch(DATA_URL, opts)
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (json) { global.clearTimeout(timer); renderData(json, parts); })
      .catch(function () { global.clearTimeout(timer); renderEmpty(parts, '离线产物未生成或读取失败'); });
  }

  global.CouponPriceCompare = { boot: boot, normalizeTitle: normalizeTitle, version: 1 };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
