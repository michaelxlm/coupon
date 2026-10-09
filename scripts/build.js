#!/usr/bin/env node
/* ==========================================================================
 * build.js · 构建期预渲染券网格 + schema.org 结构化数据（零依赖，Node 18+）
 *
 * 背景：coupon 为纯静态站，券网格此前全靠 coupon-page.js 运行时 fetch 注入，
 * HTML 源码为空。本站主打中文京东券、主入口是百度，而百度对 JS 渲染支持弱 →
 * 券内容对爬虫不可见。本脚本在部署前拉一次后端「精选 + 周榜」数据，把券卡写进
 * index.html 的 #cpGrid（首屏可见、可被索引），运行时 JS 仍会清空重绘（渐进增强，
 * 禁用 JS 也能读到券）。同时生成 ItemList/Product/Offer 的 JSON-LD 争取富媒体摘要。
 *
 * 幂等：注入内容用 START/END 注释标记包裹，重复运行整段替换，不会叠加。
 * fail-soft：任何网络/解析异常都不抛出（exit 0），保持原文件不动，绝不阻断部署。
 *
 * 用法：
 *   node scripts/build.js
 * 环境变量（可选）：
 *   COUPON_API_BASE  默认 https://api.xuyiheng.com
 *   COUPON_MAIN_URL  默认 coupon.zangeng.com（须已在 main-api 登记，否则 sourceGuard 拦截返回空）
 *   COUPON_SITE_URL  默认 https://coupon.zangeng.com （canonical / JSON-LD url 前缀）
 * ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const API_BASE = process.env.COUPON_API_BASE || 'https://api.xuyiheng.com';
const MAIN_URL = process.env.COUPON_MAIN_URL || 'coupon.zangeng.com';
const SITE_URL = (process.env.COUPON_SITE_URL || 'https://coupon.zangeng.com').replace(/\/+$/, '');
const ROOT = path.resolve(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'index.html');

const GRID_START = '<!-- PRERENDER:GRID:START -->';
const GRID_END = '<!-- PRERENDER:GRID:END -->';
const JSONLD_START = '<!-- PRERENDER:JSONLD:START -->';
const JSONLD_END = '<!-- PRERENDER:JSONLD:END -->';

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

function buildCard(c) {
  const link = cardLink(c);
  const cid = String(c.tao_id || c._id || '');
  const off = Number(c.couponDiscount) || 0;
  const finalPrice = Number(c.price) || 0;
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
  if (off > 0) html += `<span class="cp-off">券 ¥${esc(off)}</span>`;
  if (finalPrice > 0) html += `<span class="cp-final">¥${esc(finalPrice)}</span>`;
  html += '</div></a>';
  return html;
}

function buildJsonLd(list) {
  const items = list.slice(0, 20).map((c, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    url: cardLink(c) || SITE_URL,
    item: {
      '@type': 'Product',
      name: c.title || '京东优惠券',
      image: safeUrl(c.pict_url) || undefined,
      description: c.jianjie || '京东优惠券，先领券再下单更省。',
      offers: {
        '@type': 'Offer',
        price: Number(c.price) || 0,
        priceCurrency: 'CNY',
        url: cardLink(c) || SITE_URL,
        availability: 'https://schema.org/InStock',
      },
    },
  }));
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: '京东优惠券 · 限时领券中心',
    url: SITE_URL + '/',
    itemListElement: items,
  };
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

async function run() {
  let original;
  try {
    original = fs.readFileSync(HTML_FILE, 'utf8');
  } catch (err) {
    console.warn('[build] 找不到 index.html，跳过预渲染：', err.message);
    return;
  }

  // 拉数据（精选 + 周榜），任一失败都不阻断，尽力合并去重
  let list = [];
  try {
    const [ featured, week ] = await Promise.all([
      fetchList('/random?limit=12').catch(() => []),
      fetchList('/rank?period=week&limit=12').catch(() => []),
    ]);
    const seen = new Set();
    list = featured.concat(week).filter(c => {
      const key = c.tao_id || c._id || c.item_url || c.title;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (err) {
    console.warn('[build] 拉取券数据失败，跳过预渲染（不阻断部署）：', err.message);
    return;
  }

  if (!list.length) {
    console.warn('[build] 未取到券数据（sourceGuard 未放行 / 无手选券），保持原 HTML 不变。');
    return;
  }

  // 只有当标记存在时才注入（避免把 HTML 结构改坏；标记须预置在 index.html 中）
  if (original.includes(GRID_START) && original.includes(GRID_END)) {
    const gridHtml = list.map(buildCard).join('\n        ');
    original = replaceBlock(original, GRID_START, GRID_END, gridHtml);
  } else {
    console.warn('[build] index.html 缺少 PRERENDER:GRID 标记，跳过券网格注入。');
  }

  if (original.includes(JSONLD_START) && original.includes(JSONLD_END)) {
    const ld = '<script type="application/ld+json">\n' + JSON.stringify(buildJsonLd(list), null, 0) + '\n</script>';
    original = replaceBlock(original, JSONLD_START, JSONLD_END, ld);
  }

  fs.writeFileSync(HTML_FILE, original);
  console.log(`[build] 预渲染 ${list.length} 张券卡 + JSON-LD 已写入 index.html`);
}

run().catch(err => {
  // 兜底：脚本任何未捕获异常都不影响部署
  console.warn('[build] 预渲染异常（忽略，不阻断部署）：', err && err.message);
});
