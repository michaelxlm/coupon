/*!
 * coupon-quality.js · 券质量与相关性统一口径（浏览器 / Node 双环境）
 * ------------------------------------------------------------------
 * 单一事实源：构建脚本（../../scripts/*.js）与前台页面（coupon-page.js /
 * list-page.js / favorites.js）都从这里取清洗、去重、过期判定与搜索相关性打分。
 * 硬口径：没有可点击 couponUrl 或券额为 0 的记录不是「券」，不得进入任何券池。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CouponQuality = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var YEAR_MS = 365 * 24 * 3600 * 1000;

  function validUrl(u) {
    if (typeof u !== 'string') return false;
    return /^https?:\/\/\S+$/i.test(u.trim());
  }

  function firstUrl(c) {
    if (!c) return '';
    var u = c.couponUrl || c.couponURL || '';
    return validUrl(u) ? String(u).trim() : '';
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  /** 一张券是否真的可领：可点击券链 + 券额 > 0。clickURL 只是商品推广链，不算券。 */
  function hasCoupon(c) {
    if (!c) return false;
    return !!firstUrl(c) && num(c.couponDiscount) > 0;
  }

  function endMs(c) {
    if (!c) return 0;
    var v = c.couponEndTime || c.endTime || c.couponEndDate || 0;
    if (!v) return 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    var s = String(v).trim();
    if (!s) return 0;
    if (/^\d+$/.test(s)) { var n = Number(s); return n < 1e12 ? n * 1000 : n; }
    var t = Date.parse(s.replace(/-/g, '/'));
    return isFinite(t) ? t : 0;
  }

  /** ok | long | unknown | expired —— long 表示超长有效期，展示为「长期有效」而非具体日期 */
  function expiryState(c, now) {
    var ms = endMs(c);
    if (!ms) return 'unknown';
    var t = now || Date.now();
    if (ms <= t) return 'expired';
    if (ms > t + YEAR_MS) return 'long';
    return 'ok';
  }

  function saveScore(c) {
    if (!c) return 0;
    var off = num(c.couponDiscount);
    var quota = num(c.couponQuota);
    return off + (quota ? Math.min(100, (off / quota) * 100) : off * 0.4);
  }

  function normalizeTitle(t) {
    return String(t || '')
      .toLowerCase()
      .replace(/[\s\u00a0]+/g, '')
      .replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '')
      .replace(/[a-z]$/, '')
      .slice(0, 60);
  }

  function dedupeKey(c) {
    if (!c) return '';
    if (c.tao_id) return 't:' + String(c.tao_id);
    if (c._id) return 'i:' + String(c._id);
    if (c.item_url) return 'u:' + String(c.item_url).split('?')[0];
    var t = normalizeTitle(c.title);
    return t ? 'n:' + t + '|' + Math.round(num(c.price) * 10) : firstUrl(c);
  }

  /** 保留券额更高 / 更新的那条，避免同款多券刷屏 */
  function dedupe(arr) {
    var seen = Object.create(null);
    var out = [];
    (arr || []).forEach(function (c) {
      var k = dedupeKey(c);
      if (!k) return;
      var prev = seen[k];
      if (prev === undefined) { seen[k] = out.length; out.push(c); return; }
      var old = out[prev];
      if (saveScore(c) > saveScore(old)) out[prev] = c;
    });
    return out;
  }

  function sortByValue(arr) {
    return (arr || []).slice().sort(function (a, b) {
      var d = saveScore(b) - saveScore(a);
      if (Math.abs(d) > 0.001) return d;
      return (Number(b.createTime) || 0) - (Number(a.createTime) || 0);
    });
  }

  /**
   * 所有券池的唯一入口：过滤无券 / 已过期，跨页去重，按省钱力度排序。
   * opts.keepOrder=true 时保留原顺序（榜单等已由后端排好序的场景）。
   */
  function cleanList(arr, opts) {
    var o = opts || {};
    var now = Date.now();
    var list = (arr || []).filter(function (c) {
      return hasCoupon(c) && expiryState(c, now) !== 'expired';
    });
    var out = dedupe(list);
    return o.keepOrder ? out : sortByValue(out);
  }

  /** 搜索相关性：标题前缀 > 标题包含 > 简介包含；券额与新鲜度做小幅加权 */
  function relevanceScore(c, kw) {
    if (!c || !kw) return saveScore(c);
    var q = String(kw).trim().toLowerCase();
    if (!q) return saveScore(c);
    var title = String(c.title || '').toLowerCase();
    var extra = String(c.jianjie || c.keywords || c.category || '').toLowerCase();
    var score = 0;
    if (title.indexOf(q) === 0) score += 120;
    else if (title.indexOf(q) > 0) {
      score += 60;
      if (title.indexOf(q) <= 4) score += 15;
    } else if (extra.indexOf(q) >= 0) score += 12;
    if (!title) score -= 40;
    if (title.length < 6) score -= 10;
    score += Math.min(30, num(c.couponDiscount));
    var age = Date.now() - (Number(c.createTime) || Number(c.createdAt) || 0);
    if (age > 0 && age < 7 * 24 * 3600 * 1000) score += 8;
    return score;
  }

  function rankByRelevance(arr, kw) {
    return (arr || []).slice().sort(function (a, b) {
      var d = relevanceScore(b, kw) - relevanceScore(a, kw);
      if (Math.abs(d) > 0.001) return d;
      return saveScore(b) - saveScore(a);
    });
  }

  function platformLabel(c) {
    var p = String((c && c.platform) || '').toLowerCase();
    if (p === 'taobao' || p === 'tb') return '淘宝';
    if (p === 'jd' || p === 'jingdong') return '京东';
    if (p === 'pdd') return '拼多多';
    return p ? p.toUpperCase() : '全网';
  }

  return {
    validUrl: validUrl,
    firstUrl: firstUrl,
    hasCoupon: hasCoupon,
    endMs: endMs,
    expiryState: expiryState,
    saveScore: saveScore,
    normalizeTitle: normalizeTitle,
    dedupeKey: dedupeKey,
    dedupe: dedupe,
    sortByValue: sortByValue,
    cleanList: cleanList,
    relevanceScore: relevanceScore,
    rankByRelevance: rankByRelevance,
    platformLabel: platformLabel,
    YEAR_MS: YEAR_MS
  };
});
