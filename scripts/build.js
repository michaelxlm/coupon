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

const API_BASE = process.env.COUPON_API_BASE || 'https://api.xuyiheng.com';
const MAIN_URL = process.env.COUPON_MAIN_URL || 'coupon.zangeng.com';
const SITE_URL = (process.env.COUPON_SITE_URL || 'https://coupon.zangeng.com').replace(/\/+$/, '');
const ROOT = path.resolve(__dirname, '..');
const CAT_DIR = path.join(ROOT, 'cat');
const TOKEN = '2026.10.12b';

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
  slogan: '京东优惠券，先领券再下单更省',
  icp: '京ICP备18062653号-8',
  icp_url: 'https://beian.miit.gov.cn/',
  nav: [
    { label: '领券中心', url: '/' },
    { label: '全部好物', url: '/browse.html' },
    { label: '榜单', url: '/rank.html' },
    { label: '品类', url: '/category.html' },
    { label: '攻略', url: '/guide.html' },
    { label: '小满手记', url: 'https://zangeng.com/', external: true },
  ],
  footer_nav: [
    { title: '站点', links: [
      { label: '领券中心', url: '/' },
      { label: '全部好物', url: '/browse.html' },
      { label: '榜单', url: '/rank.html' },
      { label: '品类', url: '/category.html' },
      { label: '领券攻略', url: '/guide.html' },
      { label: '凑单计算器', url: '/calculator.html' },
      { label: '大促日历', url: '/holidays.html' },
      { label: '双 11 专题', url: '/double11.html' },
      { label: '我的收藏', url: '/favorites.html' },
      { label: '关于与免责', url: '/about.html' },
      { label: '小满手记', url: 'https://zangeng.com/', external: true },
    ] },
    { title: '更多站点', links: [
      { label: '建站向导 · xuliming.com', url: 'https://xuliming.com/', external: true },
      { label: '配色工具 · 2002cs.com', url: 'https://2002cs.com/', external: true },
      { label: '开发者工具箱 · fangkelianmeng.com', url: 'https://fangkelianmeng.com/', external: true },
      { label: '实测手记 · 585.ink', url: 'https://585.ink/', external: true },
      { label: '历史知识库 · 20101115.com', url: 'https://20101115.com/', external: true },
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
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'coupon-build/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const d = (json && json.data) || {};
    return Array.isArray(d.data) ? d.data : (Array.isArray(d.list) ? d.list : []);
  } finally {
    clearTimeout(timer);
  }
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
      name: c.title || '京东优惠券',
      image: safeUrl(c.pict_url) || undefined,
      description: c.jianjie || '京东优惠券，先领券再下单更省。',
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
  fs.writeFileSync(file, html);
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
  fs.writeFileSync(file, html);
  console.log('[build] ' + path.basename(file) + '：chrome 委托 shared 渲染' + (pageNav ? ('（高亮 ' + pageNav + '）') : ''));
}

/* ---------------------------- 品类落地页模板 ---------------------------- */
function catPageShell(cat, list) {
  const url = SITE_URL + '/cat/' + cat.slug + '.html';
  const title = `${cat.name}优惠券 · 京东${cat.name}领券 | 小满券仓`;
  const desc = cat.desc + ' 数据由折淘客提供，领券后跳转京东活动页下单，最终优惠以京东活动页为准。';
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
  <meta name="keywords" content="${esc('京东' + cat.name + '优惠券,' + cat.name + '券,领券中心,满减券')}">
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
  <link rel="stylesheet" href="/assets/css/tokens.css?v=${TOKEN}">
  <link rel="stylesheet" href="/assets/css/main.css?v=${TOKEN}" />
  <link rel="stylesheet" href="/assets/css/coupon.css?v=${TOKEN}" />
</head>
<body data-page="category" data-mode="category" data-kw="${esc(cat.kw)}" data-theme-default="light" data-build="${TOKEN}">
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
          <p class="section-desc">实时${esc(cat.name)}相关京东优惠券，先领券再下单更省。</p>
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

        <p class="cp-note">优惠券展示与核销由京东 / 折淘客完成，本站仅作内容聚合与跳转，不参与交易。</p>
      </div>
    </section>
  </main>

  ${P.renderFooter(COUPON_SITE, {}, { contactTitle: '联系', showSocial: false, showFooterLinks: false, footerAdSlot: 'footer' })}

  <script src="/assets/js/tracker.js?v=${TOKEN}"></script>
  <script src="/assets/js/conversion.js?v=${TOKEN}"></script>
  <script src="/assets/js/app.js?v=${TOKEN}"></script>
  <script src="/assets/js/store.js?v=${TOKEN}"></script>
  <script src="/assets/js/list-page.js?v=${TOKEN}"></script>
  <script>window.AdSlotsConfig={site:"coupon-zangeng",fallbackSrc:'/data/ad-slots.json'};</script>
  <script src="https://antucao.oss-cn-beijing.aliyuncs.com/js/ad-slots.js" defer></script>
</body>
</html>
`;
}

function todayIso() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function writeSitemap(slugs) {
  const lm = todayIso();
  const urls = [
    ['/', '1.0', 'daily'],
    ['/double11.html', '0.95', 'daily'],
    ['/browse.html', '0.9', 'daily'],
    ['/rank.html', '0.9', 'daily'],
    ['/category.html', '0.8', 'weekly'],
  ];
  for (const s of slugs) urls.push(['/cat/' + s + '.html', '0.7', 'daily']);
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

  // 并发拉各页数据（各自 fail-soft）
  const [ featured, week, browseList, rankList ] = await Promise.all([
    safeList('/random?limit=12'),
    safeList('/rank?period=week&limit=12'),
    safeList('/paging?page=1&pageSize=20&sort=discount'),
    safeList('/rank?period=week&limit=50'),
  ]);
  const catLists = {};
  if (categories.length) {
    const lists = await Promise.all(categories.map(c => safeList('/paging?search=' + encodeURIComponent(c.kw) + '&page=1&pageSize=20&sort=discount')));
    categories.forEach((c, i) => { catLists[c.slug] = sortByValue(lists[i]); });
  }

  // 双 11 专题：大额券榜单（月榜，券面额降序）+ 手选池合并去重，仅留有券额/到手价的商品（search 采集池无券额会渲成空卡，故不用），再按省钱力度取 top N
  const [ d11Rank, d11Feat ] = await Promise.all([
    safeList('/rank?period=month&limit=100'),
    safeList('/random?limit=40'),
  ]);
  const d11Seen = new Set();
  const d11List = sortByValue(d11Rank.concat(d11Feat).filter(c => {
    const key = c.tao_id || c._id || c.item_url || c.title;
    if (!key || d11Seen.has(key)) return false;
    if ((Number(c.couponDiscount) || 0) <= 0 && (Number(c.price) || 0) <= 0) return false;
    d11Seen.add(key); return true;
  })).slice(0, D11_LIMIT);

  // 1) index：精选 + 周榜合并去重后按省钱力度排序（攒量期先让刚需高折扣品靠前）
  try {
    const seen = new Set();
    const idxList = sortByValue(featured.concat(week).filter(c => {
      const key = c.tao_id || c._id || c.item_url || c.title;
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    }));
    if (idxList.length) prerenderFile(path.join(ROOT, 'index.html'), idxList, '京东优惠券 · 限时领券中心', SITE_URL + '/');
    else console.warn('[build] index 未取到券数据，保持原 HTML 不变。');
  } catch (e) { console.warn('[build] index 预渲染异常（忽略）：', e.message); }

  // 2) browse / rank（同样按省钱力度重排；rank 后端已是券面额口径，此处统一兼得折扣率）
  try { prerenderFile(path.join(ROOT, 'browse.html'), sortByValue(browseList), '全部好物优惠券 · 京东券大全', SITE_URL + '/browse.html'); } catch (e) { console.warn('[build] browse 异常：', e.message); }
  try { prerenderFile(path.join(ROOT, 'rank.html'), sortByValue(rankList), '京东优惠券榜单 · 日榜周榜月榜', SITE_URL + '/rank.html'); } catch (e) { console.warn('[build] rank 异常：', e.message); }

  // 2.5) double11：专题未取到券数据时保持原 HTML（大促页不被空网格覆盖）
  try {
    if (d11List.length) prerenderFile(path.join(ROOT, 'double11.html'), d11List, '双 11 必囤好物 · 京东优惠券专题', SITE_URL + '/double11.html');
    else console.warn('[build] double11 未取到券数据，保持原 HTML 不变。');
  } catch (e) { console.warn('[build] double11 异常（忽略）：', e.message); }

  // 3) cat 页：壳始终写盘（即使无券也不 404）
  if (categories.length) {
    try {
      fs.mkdirSync(CAT_DIR, { recursive: true });
      for (const c of categories) {
        const html = catPageShell(c, catLists[c.slug] || []);
        fs.writeFileSync(path.join(CAT_DIR, c.slug + '.html'), html);
        console.log(`[build] cat/${c.slug}.html：生成，含 ${(catLists[c.slug] || []).length} 张券卡`);
      }
    } catch (e) { console.warn('[build] 生成品类页异常（忽略）：', e.message); }
  }

  // 4) sitemap
  writeSitemap(categories.map(c => c.slug));
}

run().catch(err => {
  // 兜底：脚本任何未捕获异常都不影响部署
  console.warn('[build] 预渲染异常（忽略，不阻断部署）：', err && err.message);
});
