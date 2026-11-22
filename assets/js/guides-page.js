/*!
 * guides-page.js · 长文导购页真实内容渲染
 * 中台 content/list 目前没有 published 文章，这里不挂空壳：
 * 直接用当前券快照生成「按品类 / 按预算 / 按力度」的真实可点导购卡片。
 */
(function (global) {
  'use strict';
  var Q = global.CouponQuality || {};
  var API = 'https://api.xuyiheng.com/api/v1/front/coupon/jd/paging?page=1&pageSize=60&sort=discount&mainUrl=coupon.zangeng.com';
  var SCENES = [
    { slug: 'digital', title: '手机数码怎么买最划算', desc: '先挑大面额券，再比到手价；耳机、充电器等配件券常常比整机更值得领。' },
    { slug: 'appliance', title: '家用电器囤券指南', desc: '大家电看满减门槛，小家电看券后价；注意国家补贴与店铺券能否叠加。' },
    { slug: 'beauty', title: '美妆个护领券顺序', desc: '先领店铺券再加购，凑够门槛后看是否还能叠加平台券，别为凑单买不需要的。' },
    { slug: 'food', title: '食品生鲜囤货清单', desc: '零食、生鲜券时效短，建议按消耗速度买；生鲜优先看冷链与配送范围。' },
    { slug: 'baby', title: '母婴用品省钱思路', desc: '奶粉尿裤认准官方渠道，大件童车先看券后价再决定是否等待大促。' },
    { slug: 'home', title: '家居收纳焕新怎么领券', desc: '收纳、床品按实际尺寸选；先量后买，券只是锦上添花，别为满减硬凑。' }
  ];
  var KW = {
    digital: '手机', appliance: '家电', beauty: '面霜', food: '零食', baby: '儿童', home: '收纳'
  };

  function clean(arr) {
    return (Q.cleanList || function (a) { return a || []; })(arr);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    var v = Number(n) || 0;
    return v.toFixed(v % 1 === 0 ? 0 : 2);
  }
  function linkOf(c) {
    return (Q.firstUrl && Q.firstUrl(c)) || c.clickURL || c.item_url || '';
  }
  function pick(list, slug) {
    var kw = KW[slug] || '';
    var own = list.filter(function (c) { return String(c.title || '').indexOf(kw) >= 0; });
    return (own.length >= 2 ? own : list).slice(0, 3);
  }
  function cardHtml(scene, items, fallback) {
    var chips = items.map(function (c) {
      var href = linkOf(c);
      return '<a class="cp-guide-pick" href="' + esc(href) + '" rel="sponsored noopener" target="_blank">'
        + '<span class="cp-guide-pick-name">' + esc(String(c.title || '').slice(0, 26)) + '</span>'
        + '<span class="cp-guide-pick-off">券 ¥' + money(c.couponDiscount) + '</span></a>';
    }).join('');
    return '<article class="card cp-guide-card">'
      + '<span class="eyebrow">' + (fallback ? '全网高力度精选' : '品类精选') + '</span>'
      + '<h3>' + esc(scene.title) + '</h3>'
      + '<p>' + esc(scene.desc) + '</p>'
      + '<div class="cp-guide-picks">' + (chips || '<p class="muted">该品类暂无在架券，先看全网好券。</p>') + '</div>'
      + '<a class="card-link" href="/cat/' + esc(scene.slug) + '.html">进入' + esc(scene.title.split('怎么')[0].split('指南')[0].split('清单')[0].split('思路')[0]) + '专区 →</a>'
      + '</article>';
  }
  function render(list) {
    var grid = document.getElementById('guidesGrid');
    if (!grid) return;
    var cleanList = clean(list);
    if (!cleanList.length) {
      grid.innerHTML = '<p class="cp-empty">暂时没有可展示的在架券，请稍后刷新。</p>';
      return;
    }
    grid.innerHTML = SCENES.map(function (s) {
      var own = cleanList.filter(function (c) { return String(c.title || '').indexOf(KW[s.slug] || '') >= 0; });
      return cardHtml(s, pick(cleanList, s.slug), own.length < 2);
    }).join('');
    var stamp = document.getElementById('guidesStamp');
    if (stamp) stamp.textContent = '内容依据 ' + new Date().toLocaleDateString('zh-CN') + ' 的在架券快照生成，领券以商家活动页为准。';
  }
  function fromSnapshot(cb) {
    var ctrl = global.AbortController ? new global.AbortController() : null;
    var timer = global.setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } } }, 8000);
    global.fetch('/data/coupon-snapshot.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        global.clearTimeout(timer);
        var snap = j || {};
        cb((snap.browse || []).concat(snap.featured || []).concat((snap.category && Object.keys(snap.category).reduce(function (a, k) { return a.concat(snap.category[k] || []); }, [])) || []));
      })
      .catch(function () { global.clearTimeout(timer); cb([]); });
  }
  function boot() {
    var ctrl = global.AbortController ? new global.AbortController() : null;
    var timer = global.setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } } }, 8000);
    global.fetch(API, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        global.clearTimeout(timer);
        var list = (j && j.data && (j.data.list || j.data.data)) || [];
        if (list.length) render(list); else fromSnapshot(render);
      })
      .catch(function () { global.clearTimeout(timer); fromSnapshot(render); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
