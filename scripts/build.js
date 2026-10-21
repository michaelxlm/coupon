#!/usr/bin/env node
/* ==========================================================================
 * build.js · 构建期预渲染券内容 + 生成品类落地页 + 刷新 sitemap（零依赖，Node 18+）
 *
 * 背景：coupon 为纯静态站，券网格此前全靠运行时 JS fetch 注入，HTML 源码为空。
 * 本站主入口是百度等弱 JS 爬虫 → 券内容需构建期落进 HTML 才能被索引。
 * 本脚本在部署前：
 *   0) 全部手写页（index/browse/rank/category/guide/calculator/holidays/favorites/about/404）
 *      的 header/footer chrome 委托 shared-partials renderHeader/renderFooter 渲染（WO-86）：
 *      CHROME 标记内整段覆盖、标记外不动 → 「六站一处改 chrome 生效」且重跑幂等，body 内容原样保留；
 *   1) 预渲染 index.html（精选 + 周榜）券网格 + ItemList JSON-LD；
 *   2) 预渲染 browse.html（全部好物 paging 首页）、rank.html（周榜 50）；
 *   3) 依 data/categories.json 生成 cat/<slug>.html 品类落地页（关键词映射，壳始终写盘，
 *      即使后端不可达也不 404，仅券网格 fail-soft 留空态）；
 *   4) 依固定页面清单 + 品类 slug 重写 sitemap.xml。
 *
 * 幂等：注入内容用 START/END 注释标记包裹，重复运行整段替换，不会叠加。
 * fail-soft：任何网络/解析异常都不抛出（exit 0），页面壳仍写盘，绝不阻断部署。
 *
 * 用法：node scripts/build.js
 * 环境变量（可选）：
 *   COUPON_API_BASE  默认 https://api.xuyiheng.com
 *   COUPON_MAIN_URL  默认 coupon.zangeng.com（须已在 main-api 登记，否则 sourceGuard 拦截返回空）
 *   COUPON_SITE_URL  默认 https://coupon.zangeng.com （canonical / JSON-LD url 前缀）
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./shared-partials'); // WO-85 阶段二：header/footer/ad-slot 委托跨站单一源
const NAV = require('./shared-navigation'); // WO-93：原生导航无缝化（Speculation Rules 预取 + View Transitions）单一源
const { buildTopics } = require('./build-topics'); // WO-125：AI 场景导购 + 实时比价落地页（复用本次快照对象预渲染）

const API_BASE = process.env.COUPON_API_BASE || 'https://api.xuyiheng.com';
const MAIN_URL = process.env.COUPON_MAIN_URL || 'coupon.zangeng.com';
const SITE_URL = (process.env.COUPON_SITE_URL || 'https://coupon.zangeng.com').replace(/\/+$/, '');
const ROOT = path.resolve(__dirname, '..');
const CAT_DIR = path.join(ROOT, 'cat');
const GUIDES_DIR = path.join(ROOT, 'guides');

// W3 长文导购页：单次构建最多预渲染篇数（控制文件数与抓取配额，分批扩展）
const GUIDE_LIMIT = 60;

// 双 11 专题取数量（大额券榜单 + 手选池合并去重后按省钱力度取 top N）
const D11_LIMIT = 24;

const GRID_START = '<!-- PRERENDER:GRID:START -->';
const GRID_END = '<!-- PRERENDER:GRID:END -->';
const JSONLD_START = '<!-- PRERENDER:JSONLD:START -->';
const JSONLD_END = '<!-- PRERENDER:JSONLD:END -->';

// WO-86：header/footer chrome 委托 shared-partials 渲染的区块标记（标记内整段覆盖，幂等）
const CHROME_HDR_START = '<!-- CHROME:HEADER:START -->';
const CHROME_HDR_END = '<!-- CHROME:HEADER:END -->';
const CHROME_FTR_START = '<!-- CHROME:FOOTER:START -->';
const CHROME_FTR_END = '<!-- CHROME:FOOTER:END -->';

// 站点静态 chrome（header/footer 数据源）：委托 shared-partials 渲染，不再内联字面量
const COUPON_SITE = {
  site_name: '小满券仓',
  logo_text: '券',
  domain: 'coupon.zangeng.com',
  slogan: '全网优惠券，先领券再下单更省',
  icp: '京ICP备18062653号-26',
  icp_url: 'https://beian.miit.gov.cn/',
  nav: [
    { label: '领券中心', url: '/' },
    { label: '全部好物', url: '/browse.html' },
    { label: '榜单', url: '/rank.html' },
    { label: '品类', url: '/category.html' },
    { label: '攻略', url: '/guide.html' },
    { label: '长文导购', url: '/guides.html' },
    { label: '小满手记', url: 'https://zangeng.com/', external: true },
  ],
  footer_nav: [
    { title: '导航', links: [
      { label: '领券中心', url: '/' },
      { label: '全部好物', url: '/browse.html' },
      { label: '榜单', url: '/rank.html' },
      { label: '降价热榜', url: '/drops.html' },
      { label: '品类', url: '/category.html' },
      { label: '领券攻略', url: '/guide.html' },
      { label: '凑单计算器', url: '/calculator.html' },
      { label: '大促日历', url: '/holidays.html' },
      { label: '双 11 专题', url: '/double11.html' },
      { label: '我的收藏', url: '/favorites.html' },
      { label: '关于与免责', url: '/about.html' },
    ] },
  ],
  contact: { email: 'xlm8826@gmail.com', feedback_url: 'https://antucao.com' },
};
const COUPON_PAGE = { nav: '/category.html' }; // 品类落地页恒高亮「品类」

// WO-86：全部手写页 chrome 委托 shared 渲染。key=文件名，value=导航高亮的 url（'' = 不高亮）。
// 注意：calculator / holidays 归在「攻略」下（与改造前各页 is-active 一致），favorites/about/404 无高亮。
const STATIC_PAGES = {
  'index.html': '/',
  'browse.html': '/browse.html',
  'rank.html': '/rank.html',
  'category.html': '/category.html',
  'guide.html': '/guide.html',
  'calculator.html': '/guide.html',
  'holidays.html': '/guide.html',
  'favorites.html': '',
  'double11.html': '',
  'my-alerts.html': '',
  'about.html': '',
  '404.html': '',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(u) {
  if (typeof u !== 'string') return '';
  const v = u.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (/^\/\//.test(v)) return 'https:' + v;
  return '';
}

// 与前端 buildCard 同口径：优先 clickURL → couponUrl → item_url
function cardLink(c) {
  return safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url) ||
    (c.item_url ? 'https://' + String(c.item_url).replace(/^https?:\/\//i, '') : '');
}

async function fetchList(p) {
  const url = API_BASE + '/api/v1/front/coupon/jd' + p + (p.includes('?') ? '&' : '?') + 'mainUrl=' + encodeURIComponent(MAIN_URL);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await pacedFetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'coupon-build/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const d = (json && json.data) || {};
    return Array.isArray(d.data) ? d.data : (Array.isArray(d.list) ? d.list : []);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------- 同源自击限流与错峰（2026-10-20 生产排查） ----------------------
 * 本脚本跑在 39.107 的 self-hosted runner 上直打本机中台 API：
 * 旧版 Promise.all 把全部类目 paging 同时扇出，又逢 GitHub cron 排队延迟使构建落在
 * 北京 05 时档（与 05:10~05:50 内容生成/采集任务撞车），共享 mongod 被瞬时并发挤到
 * 单请求 7~35s（实测 05:09 一分钟 21 条 avg 31s），构建自身与真实用户互相拖慢。
 * 两道闸：
 *   1) 全局并发上限 + 起跑间隔：所有取数（fetchList/fetchJson）经同一个令牌位排队，
 *      把 ~30 个请求从瞬时扇出摊成平缓小流（命中搜索缓存后单请求也就百毫秒级）；
 *   2) 错峰：落入繁忙档（北京 05:00~07:00，后接 06:30 gather.history.scrapeAll）时，
 *      先把取数推迟到档尾 + 0~8 分钟随机抖动；四小时一构建，晚 1~2 小时不影响时效承诺。
 * 应急手动重建可置 COUPON_BUILD_NO_DEPEAK=1 跳过错峰；并发可经 COUPON_BUILD_CONCURRENCY 调。*/
const FETCH_CONCURRENCY = Math.max(1, Number(process.env.COUPON_BUILD_CONCURRENCY) || 2);
const FETCH_MIN_INTERVAL_MS = 400;
let _fetchActive = 0;
let _fetchLastStart = 0;
const _fetchWaiters = [];

function fetchSlotAcquire() {
  return new Promise(resolve => {
    const grant = () => {
      if (_fetchActive >= FETCH_CONCURRENCY) { _fetchWaiters.push(grant); return; }
      const wait = Math.max(0, _fetchLastStart + FETCH_MIN_INTERVAL_MS - Date.now());
      _fetchActive++;
      _fetchLastStart = Date.now() + wait; // 预占未来起跑时刻，后续排队者据此算下一格
      if (wait > 0) setTimeout(resolve, wait); else resolve();
    };
    grant();
  });
}

function fetchSlotRelease() {
  _fetchActive--;
  const next = _fetchWaiters.shift();
  if (next) next();
}

async function pacedFetch(url, opts) {
  await fetchSlotAcquire();
  try { return await fetch(url, opts); } finally { fetchSlotRelease(); }
}

async function depeakBusyWindow() {
  if (process.env.COUPON_BUILD_NO_DEPEAK === '1') return;
  const cst = new Date(Date.now() + 8 * 3600 * 1000);
  const minutes = cst.getUTCHours() * 60 + cst.getUTCMinutes();
  if (minutes < 5 * 60 || minutes >= 7 * 60) return;
  const waitMin = Math.max(1, Math.round(7 * 60 - minutes + Math.random() * 8));
  console.log('[build] 北京 05:00~07:00 为服务端采集/内容任务繁忙档，取数推迟 ' + waitMin + ' 分钟（错峰；急需立即构建置 COUPON_BUILD_NO_DEPEAK=1）');
  await new Promise(r => setTimeout(r, waitMin * 60 * 1000));
}

// 单个拉取失败不阻断，返回空数组（券网格留空态，页面壳仍写盘）
async function safeList(p) {
  try { return await fetchList(p); } catch (e) { console.warn('[build] 拉取失败 ' + p + '：', e.message); return []; }
}

function buildCard(c) {
  const link = cardLink(c);
  const cid = String(c.tao_id || c._id || '');
  const off = Number(c.couponDiscount) || 0;
  const quota = Number(c.couponQuota) || 0;
  const finalPrice = Number(c.price) || 0;
  const ct = Number(c.createTime) || 0;
  const fresh = ct && (Date.now() - ct) < 24 * 60 * 60 * 1000;
  const rel = link ? ' rel="sponsored noopener"' : '';
  const href = link ? esc(link) : '#';
  let html = `<a class="cp-card" href="${href}"${rel} target="_blank" data-track="coupon_click"`;
  if (cid) html += ` data-case="coupon:${esc(cid)}"`;
  html += '>';
  const imgSrc = safeUrl(c.pict_url);
  if (imgSrc) {
    html += `<img src="${esc(imgSrc)}" alt="${esc(c.title || '')}" width="300" height="300" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
  }
  html += `<span class="cp-name">${esc(c.title || '优惠券')}</span><div class="cp-price">`;
  if (off > 0) html += `<span class="cp-off">${esc(quota > 0 ? ('满' + quota + '减' + off) : ('券 ¥' + off))}</span>`;
  if (finalPrice > 0) html += `<span class="cp-final">¥${esc(finalPrice)}</span>`;
  var exLabel = expireLabel(c);
  if (exLabel) html += `<span class="cp-expire">${esc(exLabel)}</span>`;
  html += '</div>';
  if (fresh) html += '<span class="cp-fresh">今日新增</span>';
  html += '</a>';
  return html;
}

// 选品曝光权重（省钱力度优先，时间/佣金不再主导展示顺序）：
// 分数 = 券面额 + 折扣率×100（折扣率 = 券面额 / (到手价 + 券面额)）；同分按到手价低者靠前。
// 与前端 coupon-page.js / list-page.js 的 value 排序同口径，预渲染与运行时顺序一致。
function saveScore(c) {
  const off = Number(c.couponDiscount) || 0;
  const price = Number(c.price) || 0;
  if (off <= 0) return 0;
  return off + (off / (price + off)) * 100;
}

function sortByValue(list) {
  return list.slice().sort((a, b) => {
    const d = saveScore(b) - saveScore(a);
    if (d !== 0) return d;
    return (Number(a.price) || 0) - (Number(b.price) || 0);
  });
}

// 可索引/可用券判定：有任一可用跳转链接（clickURL/couponUrl/item_url）才算可渲染，
// 否则是死卡（运行时渲成 is-dead、不可点），预渲染/JSON-LD/快照都不应收录，避免污染索引。
function isLinkable(c) {
  return Boolean(safeUrl(c.clickURL) || safeUrl(c.couponUrl) || safeUrl(c.item_url) || (c.item_url && String(c.item_url).trim()));
}

// 过滤死链 + 按省钱力度排序（预渲染与快照统一口径）；同时剔除已过期券
function usable(list) {
  return sortByValue((list || []).filter(c => isLinkable(c) && !isExpired(c)));
}

// 券到期时间解析：兼容时间戳（秒/毫秒）与日期字符串；解析不出返回 0
function endMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  var s = String(v).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) { var n = Number(s); return s.length >= 12 ? n : n * 1000; }
  var t = Date.parse(s.replace(/\.\d+/, '').replace(/-/g, '/'));
  return isNaN(t) ? 0 : t;
}
// 已过期（有到期时间且已过）：构建期从预渲染 / 快照剔除
function isExpired(c) {
  var ms = endMs(c && c.couponEndTime);
  return ms > 0 && ms <= Date.now();
}
// 即将失效文案（3 天内）；无到期时间 / 已过期返回 ''
function expireLabel(c) {
  var ms = endMs(c && c.couponEndTime);
  if (!ms) return '';
  var diff = ms - Date.now();
  if (diff <= 0) return '';
  var d = Math.ceil(diff / 86400000);
  return d <= 1 ? '即将到期' : (d + '天后失效');
}

function renderGridHtml(list) {
  return list.map(buildCard).join('\n        ');
}

function jsonLd(list, name, url) {
  const items = list.slice(0, 20).map((c, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    url: cardLink(c) || url,
    item: {
      '@type': 'Product',
      name: c.title || '优惠券',
      image: safeUrl(c.pict_url) || undefined,
      description: (c.title ? c.title + '。' : '') + '京东/淘宝等平台联盟实时优惠，先领券再下单更省。',
      offers: {
        '@type': 'Offer',
        price: Number(c.price) || 0,
        priceCurrency: 'CNY',
        url: cardLink(c) || url,
        availability: 'https://schema.org/InStock',
      },
    },
  }));
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: name,
    url: url,
    itemListElement: items,
  };
}

function jsonLdBlock(list, name, url) {
  return '<script type="application/ld+json">\n' + JSON.stringify(jsonLd(list, name, url), null, 0) + '\n</script>';
}

// 用标记整段替换：标记间内容每次覆盖，标记外原文不动（幂等、可反复重跑）
function replaceBlock(html, start, end, inner) {
  const s = html.indexOf(start);
  const e = html.indexOf(end);
  if (s !== -1 && e !== -1 && e > s) {
    return html.slice(0, s + start.length) + '\n' + inner + '\n' + html.slice(e);
  }
  return html;
}

// 对已存在的 HTML 文件按标记注入券网格 + JSON-LD（文件/标记不存在则跳过）
function prerenderFile(file, list, name, url) {
  let html;
  try { html = fs.readFileSync(file, 'utf8'); } catch (e) { console.warn('[build] 找不到 ' + path.basename(file) + '，跳过：', e.message); return; }
  if (html.includes(GRID_START) && html.includes(GRID_END)) {
    html = replaceBlock(html, GRID_START, GRID_END, list.length ? renderGridHtml(list) : '');
  }
  if (list.length && html.includes(JSONLD_START) && html.includes(JSONLD_END)) {
    html = replaceBlock(html, JSONLD_START, JSONLD_END, jsonLdBlock(list, name, url));
  }
  fs.writeFileSync(file, NAV.injectIntoHtml(html, { site: 'coupon' }));
  console.log(`[build] ${path.basename(file)}：预渲染 ${list.length} 张券卡`);
}

// WO-86：把 <header>/<footer> 区块整段委托 renderHeader/renderFooter（标记内覆盖，标记外不动，幂等）
function injectChrome(file, pageNav) {
  let html;
  try { html = fs.readFileSync(file, 'utf8'); } catch (e) { console.warn('[build] 找不到 ' + path.basename(file) + '，跳过 chrome：', e.message); return; }
  if (!html.includes(CHROME_HDR_START) || !html.includes(CHROME_FTR_START)) {
    console.warn('[build] ' + path.basename(file) + '：缺 CHROME 标记，跳过 chrome（需先加标记）');
    return;
  }
  const header = P.renderHeader(COUPON_SITE, { nav: pageNav || undefined }, {}, { navAriaCurrent: true });
  const footer = P.renderFooter(COUPON_SITE, {}, { contactTitle: '联系', showSocial: false, showFooterLinks: false, footerAdSlot: 'footer' });
  html = replaceBlock(html, CHROME_HDR_START, CHROME_HDR_END, header);
  html = replaceBlock(html, CHROME_FTR_START, CHROME_FTR_END, footer);
  fs.writeFileSync(file, NAV.injectIntoHtml(html, { site: 'coupon' }));
  console.log('[build] ' + path.basename(file) + '：chrome 委托 shared 渲染' + (pageNav ? ('（高亮 ' + pageNav + '）') : ''));
}

/* ---------------------------- 品类落地页模板 ---------------------------- */
function catPageShell(cat, list) {
  const url = SITE_URL + '/cat/' + cat.slug + '.html';
  const title = `${cat.name}优惠券 · 全网${cat.name}领券 | 小满券仓`;
  const desc = cat.desc + ' 券数据由各平台联盟实时聚合，领券后跳转商家活动页下单，最终优惠以商家活动页为准。';
  const grid = list.length ? renderGridHtml(list) : '';
  const ld = JSON.stringify([
    {
      '@context': 'https://schema.org', '@type': 'CollectionPage',
      name: `${cat.name}优惠券`, description: desc, url: url, inLanguage: 'zh-CN',
      isPartOf: { '@type': 'WebSite', name: '小满券仓', url: SITE_URL },
    },
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '首页', item: SITE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: '品类', item: SITE_URL + '/category.html' },
        { '@type': 'ListItem', position: 3, name: cat.name, item: url },
      ],
    },
    list.length ? jsonLd(list, `${cat.name}优惠券`, url) : null,
  ].filter(Boolean));

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="keywords" content="${esc('全网' + cat.name + '优惠券,' + cat.name + '券,领券中心,满减券')}">
  <meta name="robots" content="index,follow">
  <link rel="icon" href="/assets/img/favicon.svg">
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="小满券仓">
  <meta property="og:locale" content="zh_CN">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${SITE_URL}/assets/img/og-cover.svg">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  <script type="application/ld+json">${ld}</script>
  <link rel="stylesheet" href="/assets/css/tokens.css">
  <link rel="stylesheet" href="/assets/css/main.css" />
  <link rel="stylesheet" href="/assets/css/coupon.css" />
</head>
<body data-page="category" data-mode="category" data-kw="${esc(cat.kw)}" data-theme-default="light">
  <a class="skip-link" href="#main">跳到主内容</a>
  <script>(function(){try{var t=localStorage.getItem('mrx_theme')||document.documentElement.getAttribute('data-theme-default')||'light';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
  <script>window.TrackerConfig={"endpoint":"https://api.xuyiheng.com/api/v1/public/track","project":"coupon-zangeng","terminal":"web"};</script>

  ${P.renderHeader(COUPON_SITE, COUPON_PAGE, {}, { navAriaCurrent: true })}

  <main id="main">
    ${P.renderAdSlotSection('carousel')}

    <section class="section hero">
      <div class="container">
        <span class="eyebrow">品类精选 · ${esc(cat.name)}</span>
        <h1>${esc(cat.name)}优惠券</h1>
        <p class="hero-sub">${esc(cat.desc)}</p>
        <nav class="cp-cats" aria-label="其他品类">
          <a class="cp-cat-chip" href="/category.html">全部品类</a>
        </nav>
      </div>
    </section>

    ${P.renderAdSlotSection('inline')}

    <section class="section">
      <div class="container">
        <div class="section-head left">
          <h2>${esc(cat.name)}券列表</h2>
          <p class="section-desc">实时${esc(cat.name)}相关全网优惠券，先领券再下单更省。</p>
        </div>

        <div class="cp-toolbar">
          <span class="muted">关键词：${esc(cat.kw)}</span>
          <label class="cp-sort">
            <span class="cp-sort-label">价格</span>
            <select id="listPrice" aria-label="到手价筛选">
              <option value="">全部价格</option>
              <option value="lt50">50 元以下</option>
              <option value="p50_100">50-100 元</option>
              <option value="p100_300">100-300 元</option>
              <option value="gt300">300 元以上</option>
            </select>
          </label>
          <label class="cp-sort">
            <span class="cp-sort-label">排序</span>
            <select id="listSort" aria-label="列表排序">
              <option value="value" selected>省钱力度↓</option>
              <option value="">默认</option>
              <option value="discount">券面额↓</option>
              <option value="expire">即将失效↑</option>
              <option value="priceAsc">到手价↑</option>
              <option value="priceDesc">到手价↓</option>
            </select>
          </label>
        </div>

        <div id="listState" class="cp-state" role="status" aria-live="polite" aria-atomic="true" hidden></div>
        <div id="listGrid" class="cp-grid">
          ${GRID_START}
${grid}
          ${GRID_END}
        </div>
        <div class="cp-more-wrap">
          <button id="listMore" class="btn btn-ghost" type="button" hidden>加载更多</button>
        </div>

        <p class="cp-note">优惠券展示与核销由各平台官方活动页完成，本站仅作内容聚合与跳转，不参与交易。</p>
        <div class="img-slot" data-img-slot="strip"></div>
      </div>
    </section>
  </main>

  ${P.renderFooter(COUPON_SITE, {}, { contactTitle: '联系', showSocial: false, showFooterLinks: false, footerAdSlot: 'footer' })}

  <script src="/assets/js/tracker.js"></script>
  <script src="/assets/js/conversion.js"></script>
  <script src="/assets/js/app.js"></script>
  <script src="/assets/js/store.js"></script>
  <script src="/assets/js/list-page.js"></script>
  <script>window.AdSlotsConfig={site:"coupon-zangeng",fallbackSrc:'/data/ad-slots.json'};</script>
  <script src="/assets/js/ad-slots.js" defer></script>
  <script>window.ImgSlotConfig={mainUrl:"coupon.zangeng.com",moreUrl:"https://img.fangkelianmeng.com/"};</script>
  <script src="/assets/js/img-slot.js" defer></script>
</body>
</html>
`;
}

function todayIso() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 毫秒时间戳 → YYYY-MM-DD（无/非法值回退今天）
function dateIso(ts) {
  const n = Number(ts) || 0;
  if (!n) return todayIso();
  const d = new Date(n);
  const p = x => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ---------------------- W1 券详情页 /p/<id>.html ---------------------- */
const P_DIR = path.join(ROOT, 'p');
const DETAIL_LIMIT = 120; // sitemap/文件数上限控制（防抓取配额稀释）
const DROPS_LIMIT = 24;   // 降价热榜预渲染张数

// 详情/热榜共用文件安全名（tao_id 理论仅字母数字，兼容兼容异常字符）
function safeId(c) {
  const raw = String(c.tao_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return raw;
}

// 相关推荐：标题二元字重合 + 到手价接近度打分，取 topN（同类目/同价位近似）
function relatedFor(c, pool, n) {
  const norm = s => String(s || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase();
  const selfTok = norm(c.title);
  const price = Number(c.price) || 0;
  return pool
    .filter(o => o !== c && String(o.tao_id) !== String(c.tao_id))
    .map(o => {
      const t = norm(o.title);
      let overlap = 0;
      for (let i = 0; i + 2 <= selfTok.length; i++) if (t.indexOf(selfTok.substr(i, 2)) !== -1) overlap++;
      const p = Number(o.price) || 0;
      const priceScore = (price > 0 && p > 0) ? Math.max(0, 1 - Math.abs(p - price) / Math.max(p, price)) : 0;
      return { o, s: overlap * 0.15 + priceScore };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map(x => x.o);
}

function detailPageShell(c, related) {
  const id = safeId(c);
  const url = SITE_URL + '/p/' + id + '.html';
  const off = Number(c.couponDiscount) || 0;
  const quota = Number(c.couponQuota) || 0;
  const price = Number(c.price) || 0;
  const link = cardLink(c);
  const img = safeUrl(c.pict_url);
  const title = `${c.title || '优惠券'}${off > 0 ? (' 满' + quota + '减' + off) : ''}${price > 0 ? (' 到手¥' + price) : ''} · 券详情 | 小满券仓`;
  const desc = `${c.title || '优惠券'}${off > 0 ? ('，当前券力度 满' + quota + '减' + off) : ''}${price > 0 ? ('，到手约 ¥' + price) : ''}。查看价格走势、订阅降价提醒，先领券再下单更省；最终优惠以商家活动页为准。`;
  const exLabel = expireLabel(c);
  const ld = JSON.stringify([
    {
      '@context': 'https://schema.org', '@type': 'Product',
      name: c.title || '优惠券',
      image: img || undefined,
      description: desc,
      offers: {
        '@type': 'Offer',
        price: price || undefined,
        priceCurrency: 'CNY',
        url: url,
        availability: 'https://schema.org/InStock',
        seller: { '@type': 'Organization', name: '小满券仓' },
      },
    },
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '首页', item: SITE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: '榜单', item: SITE_URL + '/rank.html' },
        { '@type': 'ListItem', position: 3, name: (c.title || '券详情').slice(0, 30), item: url },
      ],
    },
  ]);
  const powerText = off > 0 ? (quota > 0 ? ('满' + quota + '减' + off) : ('立减 ¥' + off)) : '';
  const relGrid = related.length ? related.map(buildCard).join('\n          ') : '';

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="robots" content="index,follow">
  <link rel="icon" href="/assets/img/favicon.svg">
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="小满券仓">
  <meta property="og:locale" content="zh_CN">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${esc(img || SITE_URL + '/assets/img/og-cover.svg')}">
  <meta name="twitter:card" content="summary_large_image">
  <script type="application/ld+json">${ld}</script>
  <link rel="stylesheet" href="/assets/css/tokens.css">
  <link rel="stylesheet" href="/assets/css/main.css" />
  <link rel="stylesheet" href="/assets/css/coupon.css" />
</head>
<body data-page="detail" data-theme-default="light"
      data-tao-id="${esc(id)}" data-title="${esc(c.title || '')}" data-img="${esc(img)}"
      data-price="${esc(price)}" data-quota="${esc(quota)}" data-off="${esc(off)}"
      data-url="${esc(link)}" data-platform="${esc(c.platform || 'jd')}" data-end="${esc(c.couponEndTime || '')}">
  <a class="skip-link" href="#main">跳到主内容</a>
  <script>(function(){try{var t=localStorage.getItem('mrx_theme')||document.documentElement.getAttribute('data-theme-default')||'light';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
  <script>window.TrackerConfig={"endpoint":"https://api.xuyiheng.com/api/v1/public/track","project":"coupon-zangeng","terminal":"web"};</script>

  ${P.renderHeader(COUPON_SITE, {}, {}, { navAriaCurrent: true })}

  <main id="main">
    <section class="section-sm"><div class="container"><div class="ad-slot" data-ad-slot="carousel"></div></div></section>

    <section class="section pd-hero">
      <div class="container">
        <nav class="pd-crumbs" aria-label="面包屑">
          <a href="/">首页</a> › <a href="/rank.html">榜单</a> › <span>券详情</span>
        </nav>
        <div class="pd-grid">
          <div class="pd-media">
            ${img ? `<img src="${esc(img)}" alt="${esc(c.title || '')}" width="600" height="600" decoding="async" referrerpolicy="no-referrer">` : ''}
          </div>
          <div class="pd-info">
            <h1 class="pd-title">${esc(c.title || '优惠券')}</h1>
            ${powerText ? `<div class="pd-power">${esc(powerText)}</div>` : ''}
            ${price > 0 ? `<div class="pd-final">到手价 <strong>¥${esc(price)}</strong></div>` : ''}
            ${exLabel ? `<div class="pd-expire" id="pdExpire">${esc(exLabel)}</div>` : ''}
            <div class="pd-cta-row">
              <a class="btn btn-primary pd-claim" href="${esc(link || '#')}" rel="sponsored noopener" target="_blank" data-track="coupon_click" data-case="coupon:${esc(id)}">立即领取</a>
              <button class="btn pd-alert" id="pAlert" type="button" aria-pressed="false">订阅降价提醒</button>
              <button class="btn pd-share" id="pShare" type="button" data-track="coupon_share" data-track-props='{"coupon_id":"${esc(id)}"}'>分享海报</button>
            </div>
            <p class="pd-note">券力度与价格由各平台联盟实时同步，可能随时变动，领券后以商家活动页为准。订阅降价提醒后，力度提升或到手价下降会优先提醒本浏览器（匿名设备，无需注册）。</p>
          </div>
        </div>
      </div>
    </section>

    <section class="section section-soft">
      <div class="container">
        <div class="section-head left">
          <h2>价格走势</h2>
          <p class="section-desc" id="pTrendSummary">正在加载历史力度快照…</p>
        </div>
        <div id="pTrend" class="pd-trend" role="img" aria-label="券价格历史走势折线图"></div>
      </div>
    </section>

    ${P.renderAdSlotSection('inline')}

    <section class="section">
      <div class="container">
        <div class="section-head left">
          <h2>相关推荐</h2>
          <p class="section-desc">同类目 / 同价位的在券好物，先领券再下单更省。</p>
        </div>
        <div class="cp-grid" role="list">
          ${relGrid}
        </div>
        <div class="cp-more-wrap"><a class="btn btn-ghost" href="/browse.html">查看全部好物</a></div>
      </div>
    </section>
    <div class="container"><div class="img-slot" data-img-slot="strip"></div></div>
  </main>

  ${P.renderFooter(COUPON_SITE, {}, { contactTitle: '联系', showSocial: false, showFooterLinks: false, footerAdSlot: 'footer' })}

  <script src="/assets/js/tracker.js"></script>
  <script src="/assets/js/conversion.js"></script>
  <script src="/assets/js/app.js"></script>
  <script src="/assets/js/store.js"></script>
  <script src="/assets/js/qrcode.js"></script>
  <script src="/assets/js/share.js"></script>
  <script src="/assets/js/detail-page.js"></script>
  <script>window.AdSlotsConfig={site:"coupon-zangeng",fallbackSrc:'/data/ad-slots.json'};</script>
  <script src="/assets/js/ad-slots.js" defer></script>
  <script>window.ImgSlotConfig={mainUrl:"coupon.zangeng.com",moreUrl:"https://img.fangkelianmeng.com/"};</script>
  <script src="/assets/js/img-slot.js" defer></script>
</body>
</html>
`;
}

/* ---------------------- W2 降价热榜页 /drops.html ---------------------- */
function dropsPageShell(list) {
  const url = SITE_URL + '/drops.html';
  const title = '今日降价热榜 · 券力度省钱榜 | 小满券仓';
  const desc = '小满券仓今日降价热榜：全网优惠券按省钱力度实时排序，标记历史力度下降的券，扫码战报海报一键分享，每日回访看新降。';
  const ld = JSON.stringify([
    {
      '@context': 'https://schema.org', '@type': 'CollectionPage',
      name: '今日降价热榜', description: desc, url: url, inLanguage: 'zh-CN',
      isPartOf: { '@type': 'WebSite', name: '小满券仓', url: SITE_URL },
    },
    list.length ? jsonLd(list, '今日降价热榜', url) : null,
  ].filter(Boolean));
  const grid = list.length ? list.map(buildCard).join('\n        ') : '';

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="robots" content="index,follow">
  <link rel="icon" href="/assets/img/favicon.svg">
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="小满券仓">
  <meta property="og:locale" content="zh_CN">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${SITE_URL}/assets/img/og-cover.svg">
  <script type="application/ld+json">${ld}</script>
  <link rel="stylesheet" href="/assets/css/tokens.css">
  <link rel="stylesheet" href="/assets/css/main.css" />
  <link rel="stylesheet" href="/assets/css/coupon.css" />
</head>
<body data-page="drops" data-mode="drops" data-theme-default="light">
  <a class="skip-link" href="#main">跳到主内容</a>
  <script>(function(){try{var t=localStorage.getItem('mrx_theme')||document.documentElement.getAttribute('data-theme-default')||'light';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
  <script>window.TrackerConfig={"endpoint":"https://api.xuyiheng.com/api/v1/public/track","project":"coupon-zangeng","terminal":"web"};</script>

  ${P.renderHeader(COUPON_SITE, {}, {}, { navAriaCurrent: true })}

  <main id="main">
    ${P.renderAdSlotSection('carousel')}

    <section class="section hero">
      <div class="container">
        <span class="eyebrow">每日热榜</span>
        <h1>今日降价热榜</h1>
        <p class="hero-sub">全网在券好物按省钱力度实时排序；标注「已降」的为近 30 天历史力度快照中真实降价/加码的券。每天刷新，扫码战报海报可一键分享。</p>
        <div><a class="btn" href="/my-alerts.html">我的降价提醒</a></div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div id="dropsState" class="cp-state" role="status" aria-live="polite" hidden></div>
        <div id="dropsGrid" class="cp-grid" role="list">
          ${GRID_START}
${grid}
          ${GRID_END}
        </div>
        <div id="dropsEmpty" class="cp-empty"${list.length ? ' hidden' : ''}>热榜正在上新，稍后再来。</div>
        <p class="cp-note">降价判定基于本系统每日力度快照（价低/券大均算降）；最终优惠以商家活动页为准。</p>
      </div>
    </section>
    <div class="container"><div class="img-slot" data-img-slot="strip"></div></div>
  </main>

  ${P.renderFooter(COUPON_SITE, {}, { contactTitle: '联系', showSocial: false, showFooterLinks: false, footerAdSlot: 'footer' })}

  <script src="/assets/js/tracker.js"></script>
  <script src="/assets/js/conversion.js"></script>
  <script src="/assets/js/app.js"></script>
  <script src="/assets/js/store.js"></script>
  <script src="/assets/js/qrcode.js"></script>
  <script src="/assets/js/share.js"></script>
  <script src="/assets/js/drops-page.js"></script>
  <script>window.AdSlotsConfig={site:"coupon-zangeng",fallbackSrc:'/data/ad-slots.json'};</script>
  <script src="/assets/js/ad-slots.js" defer></script>
  <script>window.ImgSlotConfig={mainUrl:"coupon.zangeng.com",moreUrl:"https://img.fangkelianmeng.com/"};</script>
  <script src="/assets/js/img-slot.js" defer></script>
</body>
</html>
`;
}

/* ---------------------- W3 长文导购页 /guides/<slug>.html ---------------------- */

// 非 jd 前缀的 front 接口拉取（content/list 等），口径同 safeList：失败给空值不阻断（同样经 pacedFetch 限流）
async function fetchJson(pathWithQuery, fallback) {
  const url = API_BASE + '/api/v1/front/coupon' + pathWithQuery + (pathWithQuery.includes('?') ? '&' : '?') + 'mainUrl=' + encodeURIComponent(MAIN_URL);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await pacedFetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'coupon-build/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    return (json && json.data) || fallback;
  } finally { clearTimeout(timer); }
}

async function safeGuides() {
  try {
    const d = await fetchJson('/content/list?page=1&pageSize=' + GUIDE_LIMIT, {});
    return Array.isArray(d.list) ? d.list.slice(0, GUIDE_LIMIT) : [];
  } catch (e) { console.warn('[build] 拉取长文列表失败（跳过 /guides 生成）：', e.message); return []; }
}

// 正文→HTML：AI 产文为纯文本/简版 markdown，先整体转义再行级变换（无裸 HTML）
function articleToHtml(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let inUl = false, inP = false;
  const closeP = () => { if (inP) { out.push('</p>'); inP = false; } };
  const closeUl = () => { if (inUl) { out.push('</ul>'); inUl = false; } };
  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  for (const raw of lines) {
    const ln = raw.trim();
    if (!ln) { closeP(); closeUl(); continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.+)$/.exec(ln))) {
      closeP(); closeUl();
      const lv = Math.min(4, m[1].length + 1); // 页内 h1 留给标题，正文 #→h2
      out.push('<h' + lv + '>' + inline(m[2]) + '</h' + lv + '>');
    } else if ((m = /^[-*]\s+(.+)$/.exec(ln))) {
      closeP();
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push('<li>' + inline(m[1]) + '</li>');
    } else if (/^\d+[.、]\s+.+$/.test(ln)) {
      closeP(); closeUl();
      out.push('<p>' + inline(ln) + '</p>');
    } else if (/^(---|\*\*\*)$/.test(ln)) {
      closeP(); closeUl(); out.push('<hr>');
    } else {
      closeUl();
      if (!inP) { out.push('<p>'); inP = true; }
      out.push(inline(ln));
    }
  }
  closeP(); closeUl();
  return out.join('\n    ');
}

// 文章关联券 id：仅当 /p/<id> 本次已生成（detailIds 白名单）才内链，避免 404
function guideRelated(a, detailIdSet) {
  if (!a.sourceId || !detailIdSet || !detailIdSet.has(String(a.sourceId))) return '';
  return `<p class="gd-coupon-cta"><a class="btn" href="/p/${esc(String(a.sourceId))}.html">查看本文对应优惠券详情</a></p>`;
}

function guideIndexShell(articles) {
  const url = SITE_URL + '/guides.html';
  const title = '省钱长文导购 · 优惠券攻略文章 | 小满券仓';
  const desc = '小满券仓导购长文集：券怎么用、怎么凑最划算、品类选购攻略，AI 流水线每日更新，先看文章再领券下单更省。';
  const cards = articles.map(a => {
    const cover = a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
    return `<a class="gd-item cp-cell" href="/guides/${esc(a.slug)}.html">${cover}<div class="gd-item-body"><h3>${esc(a.title)}</h3><p>${esc(a.excerpt || '')}</p><span class="gd-date">${esc(dateIso(a.publishedTime))}</span></div></a>`;
  }).join('\n        ');
  const ld = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: '省钱长文导购', description: desc, url: url, inLanguage: 'zh-CN',
    isPartOf: { '@type': 'WebSite', name: '小满券仓', url: SITE_URL },
  });
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="robots" content="index,follow">
  <link rel="icon" href="/assets/img/favicon.svg">
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="小满券仓">
  <meta property="og:locale" content="zh_CN">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${esc(url)}">
  <script type="application/ld+json">${ld}</script>
  <link rel="stylesheet" href="/assets/css/tokens.css">
  <link rel="stylesheet" href="/assets/css/main.css" />
  <link rel="stylesheet" href="/assets/css/coupon.css" />
</head>
<body data-page="guides" data-theme-default="light">
  <a class="skip-link" href="#main">跳到主内容</a>
  <script>(function(){try{var t=localStorage.getItem('mrx_theme')||document.documentElement.getAttribute('data-theme-default')||'light';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
  <script>window.TrackerConfig={"endpoint":"https://api.xuyiheng.com/api/v1/public/track","project":"coupon-zangeng","terminal":"web"};</script>

  ${P.renderHeader(COUPON_SITE, {}, {}, { navAriaCurrent: true })}

  <main id="main">
    <section class="section hero">
      <div class="container">
        <span class="eyebrow">导购长文</span>
        <h1>省钱长文导购</h1>
        <p class="hero-sub">券怎么用、怎么凑最划算、品类怎么选——先看文章再领券，下单更省。新文章随构建每日刷新。</p>
        <div><a class="btn" href="/">去领券中心</a> <a class="btn btn-ghost" href="/drops.html">今日降价热榜</a></div>
      </div>
    </section>
    <section class="section">
      <div class="container">
        ${articles.length ? '<div class="gd-list">\n        ' + cards + '\n        </div>' : '<div class="cp-empty">导购文章正在生产，敬请期待。</div>'}
        <p class="cp-note">文章由本站内容流水线基于实时券数据自动撰写，下单前请以商家活动页价格为准。</p>
      </div>
    </section>
    <div class="container"><div class="img-slot" data-img-slot="strip"></div></div>
  </main>

  ${P.renderFooter(COUPON_SITE, {}, { contactTitle: '联系', showSocial: false, showFooterLinks: false, footerAdSlot: 'footer' })}

  <script src="/assets/js/tracker.js"></script>
  <script src="/assets/js/app.js"></script>
</body>
</html>
`;
}

function guidePageShell(a, others, detailIdSet) {
  const url = SITE_URL + '/guides/' + a.slug + '.html';
  const title = (a.title || '导购长文') + ' | 小满券仓';
  const desc = String(a.excerpt || a.title || '').slice(0, 120);
  const pub = dateIso(a.publishedTime);
  const imgs = (a.images || []).filter(Boolean).slice(0, 3)
    .map(u => `<img class="gd-img" src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join('\n      ');
  const tags = (a.tags || []).slice(0, 6)
    .map(t => `<a class="gd-tag" href="/guides.html">#${esc(t)}</a>`).join(' ');
  const more = (others || []).slice(0, 6)
    .map(o => `<a class="gd-more" href="/guides/${esc(o.slug)}.html">${esc(o.title)}</a>`).join('\n        ');
  const crumbCat = a.sourceId && detailIdSet && detailIdSet.has(String(a.sourceId))
    ? [{ name: '券详情', url: SITE_URL + '/p/' + String(a.sourceId) + '.html' }]
    : [];
  const ld = JSON.stringify([
    {
      '@context': 'https://schema.org', '@type': 'Article',
      headline: a.title || '导购长文', description: desc, url: url,
      inLanguage: 'zh-CN', datePublished: pub,
      author: { '@type': 'Organization', name: '小满券仓' },
      publisher: { '@type': 'Organization', name: '小满券仓', url: SITE_URL },
    },
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '首页', item: SITE_URL + '/' },
        { '@type': 'ListItem', position: 2, name: '省钱长文', item: SITE_URL + '/guides.html' },
      ].concat(crumbCat.map(c => ({ '@type': 'ListItem', position: 3, name: c.name, item: c.url }))),
    },
  ]);
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="robots" content="index,follow">
  <link rel="icon" href="/assets/img/favicon.svg">
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="小满券仓">
  <meta property="og:locale" content="zh_CN">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${esc(url)}">
  ${a.cover ? '<meta property="og:image" content="' + esc(a.cover) + '">' : '<meta property="og:image" content="' + SITE_URL + '/assets/img/og-cover.svg">'}
  <script type="application/ld+json">${ld}</script>
  <link rel="stylesheet" href="/assets/css/tokens.css">
  <link rel="stylesheet" href="/assets/css/main.css" />
  <link rel="stylesheet" href="/assets/css/coupon.css" />
</head>
<body data-page="guide-article" data-theme-default="light">
  <a class="skip-link" href="#main">跳到主内容</a>
  <script>(function(){try{var t=localStorage.getItem('mrx_theme')||document.documentElement.getAttribute('data-theme-default')||'light';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
  <script>window.TrackerConfig={"endpoint":"https://api.xuyiheng.com/api/v1/public/track","project":"coupon-zangeng","terminal":"web"};</script>

  ${P.renderHeader(COUPON_SITE, {}, {}, {})}

  <main id="main">
    <article class="section gd-article">
      <div class="container">
        <nav class="gd-crumb" aria-label="面包屑"><a href="/">首页</a> › <a href="/guides.html">省钱长文</a> › <span>${esc((a.title || '').slice(0, 20))}</span></nav>
        <h1>${esc(a.title)}</h1>
        <p class="gd-meta"><time datetime="${esc(pub)}">${esc(pub)}</time> · 小满券仓内容组</p>
        ${imgs}
        <div class="gd-body">
    ${articleToHtml(a.content)}
        </div>
        ${guideRelated(a, detailIdSet)}
        <p class="gd-note">本文为内容流水线基于联盟实时数据自动撰写，仅供比价参考；下单前以商家活动页为准。本站无账号、不收集个人信息。</p>
        ${tags ? '<p class="gd-tags">' + tags + '</p>' : ''}
        ${more ? '<section class="gd-related"><h2>相关长文</h2><div class="gd-more-list">\n        ' + more + '\n        </div></section>' : ''}
      </div>
    </article>
  </main>

  ${P.renderFooter(COUPON_SITE, {}, { contactTitle: '联系', showSocial: false, showFooterLinks: false, footerAdSlot: 'footer' })}

  <script src="/assets/js/tracker.js"></script>
  <script src="/assets/js/app.js"></script>
</body>
</html>
`;
}

function writeSitemap(slugs, detailIds, guideSlugs, topicSlugs) {
  const lm = todayIso();
  const urls = [
    ['/', '1.0', 'daily'],
    ['/double11.html', '0.95', 'daily'],
    ['/browse.html', '0.9', 'daily'],
    ['/rank.html', '0.9', 'daily'],
    ['/category.html', '0.8', 'weekly'],
  ];
  for (const s of slugs) urls.push(['/cat/' + s + '.html', '0.7', 'daily']);
  for (const t of (topicSlugs || [])) urls.push(['/topic/' + t + '.html', '0.65', 'daily']);
  urls.push(['/drops.html', '0.9', 'daily']);
  for (const id of (detailIds || [])) urls.push(['/p/' + id + '.html', '0.6', 'daily']);
  urls.push(['/guides.html', '0.5', 'weekly']);
  for (const g of (guideSlugs || [])) urls.push(['/guides/' + g + '.html', '0.5', 'weekly']);
  urls.push(['/guide.html', '0.6', 'monthly']);
  urls.push(['/calculator.html', '0.6', 'monthly']);
  urls.push(['/holidays.html', '0.6', 'monthly']);
  urls.push(['/about.html', '0.5', 'monthly']);
  const body = urls.map(u =>
`  <url>
    <loc>${SITE_URL}${u[0]}</loc>
    <lastmod>${lm}</lastmod>
    <changefreq>${u[2]}</changefreq>
    <priority>${u[1]}</priority>
  </url>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  try {
    fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), xml);
    console.log('[build] sitemap.xml 已刷新（' + urls.length + ' 条 URL，lastmod=' + lm + '）');
  } catch (e) { console.warn('[build] 写 sitemap.xml 失败（忽略）：', e.message); }
}

// 运行时节点的兜底快照：写盘 data/coupon-snapshot.json（nginx 已放行），
// 前端 coupon-page.js / list-page.js 在后端 fetch 失败时用它渲染最近一次成功取到的券。
function writeSnapshot(obj) {
  try {
    const dir = path.join(ROOT, 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'coupon-snapshot.json'), JSON.stringify(obj));
    console.log('[build] coupon-snapshot.json 已生成（updatedAt=' + obj.updatedAt + '）');
  } catch (e) { console.warn('[build] 写 coupon-snapshot.json 失败（忽略）：', e.message); }
}

async function run() {
  // 0) chrome：全部手写页 header/footer 委托 shared（本地步骤，不依赖网络，始终先执行）
  for (const [name, nav] of Object.entries(STATIC_PAGES)) {
    try { injectChrome(path.join(ROOT, name), nav); } catch (e) { console.warn('[build] chrome ' + name + ' 异常（忽略）：', e.message); }
  }

  // 读品类定义（失败则不生成 cat 页，仍不影响其它预渲染）
  let categories = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'categories.json'), 'utf8'));
    categories = Array.isArray(raw.categories) ? raw.categories : [];
  } catch (e) { console.warn('[build] 读 categories.json 失败（跳过品类页）：', e.message); }

  // 错峰：避开本机凌晨采集/内容任务档（本地步骤已先执行，纯等网络）
  await depeakBusyWindow();

  // 并发拉各页数据（各自 fail-soft）
  const [ featured, week, browseList, rankList, dayRank ] = await Promise.all([
    safeList('/random?limit=12'),
    safeList('/rank?period=week&limit=12'),
    safeList('/paging?page=1&pageSize=20&sort=discount'),
    safeList('/rank?period=week&limit=50'),
    safeList('/rank?period=day&limit=50'),
  ]);
  const catLists = {};
  if (categories.length) {
    const lists = await Promise.all(categories.map(c => safeList('/paging?search=' + encodeURIComponent(c.kw) + '&page=1&pageSize=20&sort=discount')));
    categories.forEach((c, i) => { catLists[c.slug] = usable(lists[i]); });
  }
  // 快照按品类关键词（data-kw）建索引，供前端品类页回退
  const catByKw = {};
  if (categories.length) categories.forEach((c) => { catByKw[c.kw] = sortByValue(catLists[c.slug] || []); });

  // 双 11 专题：大额券榜单（月榜，券面额降序）+ 手选池合并去重，仅留有券额/到手价的商品（search 采集池无券额会渲成空卡，故不用），再按省钱力度取 top N
  const [ d11Rank, d11Feat ] = await Promise.all([
    safeList('/rank?period=month&limit=100'),
    safeList('/random?limit=40'),
  ]);
  const d11Seen = new Set();
  const d11List = sortByValue(d11Rank.concat(d11Feat).filter(c => {
    const key = c.tao_id || c._id || c.item_url || c.title;
    if (!key || d11Seen.has(key)) return false;
    if (!isLinkable(c)) return false;
    if (isExpired(c)) return false;
    if ((Number(c.couponDiscount) || 0) <= 0 && (Number(c.price) || 0) <= 0) return false;
    d11Seen.add(key); return true;
  })).slice(0, D11_LIMIT);

  // W1 详情池：本次构建已拉取的 featured + rank(day/week/month) + browse + d11 合集去重，
  // 仅留带 tao_id 且可用的券，按省钱力度取前 DETAIL_LIMIT 张逐券生成 /p/<id>.html。
  const poolSeen = new Set();
  const detailPool = [];
  for (const c of usable(featured.concat(week, rankList, dayRank, browseList, d11Rank, d11Feat))) {
    const id = safeId(c);
    if (!id || poolSeen.has(id)) continue;
    poolSeen.add(id);
    detailPool.push(Object.assign({}, c, { tao_id: id }));
    if (detailPool.length >= DETAIL_LIMIT) break;
  }
  // W2 降价热榜兜底版：力度（券面额）降序取 top N（正式版待中台 topDrops 接口）
  const dropsList = detailPool.slice()
    .filter(c => (Number(c.couponDiscount) || 0) > 0)
    .sort((a, b) => (Number(b.couponDiscount) || 0) - (Number(a.couponDiscount) || 0))
    .slice(0, DROPS_LIMIT);

  // 1) index：精选 + 周榜合并去重后按省钱力度排序（攒量期先让刚需高折扣品靠前）
  let idxList = [];
  try {
    const seen = new Set();
    idxList = sortByValue(featured.concat(week).filter(c => {
      const key = c.tao_id || c._id || c.item_url || c.title;
      if (!key || seen.has(key)) return false;
      if (!isLinkable(c)) return false;
      seen.add(key); return true;
    }));
    if (idxList.length) prerenderFile(path.join(ROOT, 'index.html'), idxList, '全网优惠券 · 限时领券中心', SITE_URL + '/');
    else console.warn('[build] index 未取到券数据，保持原 HTML 不变。');
  } catch (e) { console.warn('[build] index 预渲染异常（忽略）：', e.message); }

  // 2) browse / rank（同样按省钱力度重排；rank 后端已是券面额口径，此处统一兼得折扣率）
  try { prerenderFile(path.join(ROOT, 'browse.html'), usable(browseList), '全部好物优惠券 · 全网券大全', SITE_URL + '/browse.html'); } catch (e) { console.warn('[build] browse 异常：', e.message); }
  try { prerenderFile(path.join(ROOT, 'rank.html'), usable(rankList), '全网优惠券榜单 · 日榜周榜月榜', SITE_URL + '/rank.html'); } catch (e) { console.warn('[build] rank 异常：', e.message); }

  // 2.5) double11：专题未取到券数据时保持原 HTML（大促页不被空网格覆盖）
  try {
    if (d11List.length) prerenderFile(path.join(ROOT, 'double11.html'), d11List, '双 11 必囤好物 · 全网优惠券专题', SITE_URL + '/double11.html');
    else console.warn('[build] double11 未取到券数据，保持原 HTML 不变。');
  } catch (e) { console.warn('[build] double11 异常（忽略）：', e.message); }

  // W5 详情白名单：先取本次详情池 id；池空时沿用上一次 /p/* 产物（与 3.5 同口径），供快照写入
  let snapshotDetailIds = detailPool.map(c => String(c.tao_id));
  if (!snapshotDetailIds.length) {
    try { snapshotDetailIds = fs.readdirSync(P_DIR).filter(f => f.endsWith('.html')).map(f => f.slice(0, -5)); } catch (e) { /* 无目录 */ }
  }

  // 2.6) 快照：运行时后端不可达时的兜底数据源（配合 nginx 放行 /data/coupon-snapshot.json）
  //      构建期随部署刷新，使 api.xuyiheng.com 抖动/被墙时前端仍能渲染最近一次成功取到的券。
  let snapObj = null;
  try {
    snapObj = {
      updatedAt: new Date().toISOString(),
      featured: idxList,
      rank: {
        day: usable(dayRank),
        week: usable(rankList),
        month: usable(d11Rank),
      },
      browse: usable(browseList),
      category: catByKw,
      drops: dropsList,
      // my-alerts.js 详情链接白名单：只对已生成 /p/<id> 的券给「详情」入口，避免 404
      detailIds: snapshotDetailIds,
    };
    writeSnapshot(snapObj);
  } catch (e) { console.warn('[build] 写快照失败（忽略）：', e.message); }

  // 2.7) WO-125：AI 场景导购 + 实时比价落地页 topic/<slug>.html
  //      复用同一次快照对象预渲染（不再打后端）；全页免费无解锁门槛，
  //      ad-slot / img-slot 与 CPS data-track="coupon_click" 原样保留。
  let topicSlugs = [];
  try {
    topicSlugs = buildTopics(snapObj || {}, SITE_URL);
  } catch (e) { console.warn('[build] 生成场景导购页异常（忽略）：', e.message); }

  // 3) cat 页：壳始终写盘（即使无券也不 404）
  if (categories.length) {
    try {
      fs.mkdirSync(CAT_DIR, { recursive: true });
      for (const c of categories) {
        const html = catPageShell(c, catLists[c.slug] || []);
        fs.writeFileSync(path.join(CAT_DIR, c.slug + '.html'), NAV.injectIntoHtml(html, { site: 'coupon' }));
        console.log(`[build] cat/${c.slug}.html：生成，含 ${(catLists[c.slug] || []).length} 张券卡`);
      }
    } catch (e) { console.warn('[build] 生成品类页异常（忽略）：', e.message); }
  }

  // 3.5) W1 详情页 /p/<id>.html：逐券写盘（接口不可达时池为空也写壳？否——无 id 无法命名，
  //      空池时跳过生成保留上一次产物，fail-soft 与 cat 页同口径：有券必写，无券不 404）
  let detailIds = [];
  try {
    if (detailPool.length) {
      fs.mkdirSync(P_DIR, { recursive: true });
      detailIds = [];
      for (const c of detailPool) {
        const id = String(c.tao_id);
        const html = detailPageShell(c, relatedFor(c, detailPool, 6));
        fs.writeFileSync(path.join(P_DIR, id + '.html'), NAV.injectIntoHtml(html, { site: 'coupon' }));
        detailIds.push(id);
      }
      console.log('[build] /p/* 详情页：生成 ' + detailIds.length + ' 张');
    } else {
      try { detailIds = fs.readdirSync(P_DIR).filter(f => f.endsWith('.html')).map(f => f.slice(0, -5)); } catch (e) { /* 无目录 */ }
      console.warn('[build] 详情池为空，保留上一次 /p/* 产物（' + detailIds.length + ' 张）进 sitemap');
    }
  } catch (e) { console.warn('[build] 生成详情页异常（忽略）：', e.message); }

  // 3.6) W2 降价热榜页：壳始终写盘（空列表时前端用快照兜底渲染）
  try {
    fs.writeFileSync(path.join(ROOT, 'drops.html'), NAV.injectIntoHtml(dropsPageShell(dropsList), { site: 'coupon' }));
    console.log('[build] drops.html：生成，含 ' + dropsList.length + ' 张券卡');
  } catch (e) { console.warn('[build] 生成 drops.html 异常（忽略）：', e.message); }

  // 3.7) W3 长文导购页 /guides/<slug>.html：中台 content 接口就绪才生成；
  //      接口不可达/无发布文章时跳过并保留上一次产物（不删目录，sitemap 沿用旧 slug）
  let guideSlugs = [];
  try {
    const guides = await safeGuides();
    if (guides.length) {
      fs.mkdirSync(GUIDES_DIR, { recursive: true });
      const detailIdSet = new Set(detailIds.map(String));
      guideSlugs = [];
      for (let i = 0; i < guides.length; i++) {
        const a = guides[i];
        if (!a || !/^[A-Za-z0-9_-]{6,40}$/.test(String(a.slug || ''))) continue;
        const others = guides.filter((o, j) => j !== i && o && o.slug).slice(0, 6);
        const html = guidePageShell(a, others, detailIdSet);
        fs.writeFileSync(path.join(GUIDES_DIR, a.slug + '.html'), NAV.injectIntoHtml(html, { site: 'coupon' }));
        guideSlugs.push(String(a.slug));
      }
      fs.writeFileSync(path.join(ROOT, 'guides.html'), NAV.injectIntoHtml(guideIndexShell(guides.filter(g => guideSlugs.includes(String(g.slug)))), { site: 'coupon' }));
      console.log('[build] /guides/* 长文页：生成 ' + guideSlugs.length + ' 篇 + 索引页 guides.html');
    } else {
      try { guideSlugs = fs.readdirSync(GUIDES_DIR).filter(f => f.endsWith('.html')).map(f => f.slice(0, -5)); } catch (e) { /* 无目录 */ }
      if (guideSlugs.length) console.warn('[build] 长文接口空/不可达，保留上一次 /guides/*（' + guideSlugs.length + ' 篇）进 sitemap');
      // 索引壳始终写盘（口径同 drops.html）：sitemap 恒含 /guides.html，首建无产物时也不能 404。
      // 已有上一次 guides.html 则不覆盖（保留其文章卡片），仅在缺失时补空态壳。
      try {
        const idxPath = path.join(ROOT, 'guides.html');
        if (!fs.existsSync(idxPath)) {
          fs.writeFileSync(idxPath, NAV.injectIntoHtml(guideIndexShell([]), { site: 'coupon' }));
          console.warn('[build] guides.html 缺失，已补写空态索引壳');
        }
      } catch (e) { console.warn('[build] 补写 guides.html 空壳失败（忽略）：', e.message); }
    }
  } catch (e) { console.warn('[build] 生成长文页异常（忽略）：', e.message); }
  
  // 4) sitemap
  writeSitemap(categories.map(c => c.slug), detailIds, guideSlugs, topicSlugs);
}

run().catch(err => {
  // 兜底：脚本任何未捕获异常都不影响部署
  console.warn('[build] 预渲染异常（忽略，不阻断部署）：', err && err.message);
});
